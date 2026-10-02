import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LlmService } from '../llm/llm.service';
import { advise } from './advisor';
import { analyze, computeMetrics } from './analyzer';
import { extractWithLlm, repairWithLlm, summarizeWithLlm } from './extract/llm';
import { extractWithRules } from './extract/rules';
import { generateBpmn } from './generator';
import { repairModel } from './repair';
import {
  EngineChoice, EngineUsed, Finding, Issue, Metrics, PipelineResult, ProcessModel, Suggestion, TraceStep,
} from './types';
import { validateBpmn } from './validator';

export const MAX_REPAIRS = 3;

export interface PipelineDeps {
  llm: LlmService;
  onTrace: (t: TraceStep) => void;
}

const State = Annotation.Root({
  text: Annotation<string>(),
  engine: Annotation<EngineChoice>(),
  usedEngine: Annotation<EngineUsed>(),
  model: Annotation<ProcessModel>(),
  xml: Annotation<string>(),
  issues: Annotation<Issue[]>(),
  valid: Annotation<boolean>(),
  attempts: Annotation<number>(),
  findings: Annotation<Finding[]>(),
  suggestions: Annotation<Suggestion[]>(),
  metrics: Annotation<Metrics>(),
  summary: Annotation<string>(),
});

type S = typeof State.State;

/**
 * LangGraph state machine mirroring the architecture diagram:
 *   extract -> generate -> validate --(invalid, < 3 retries)--> repair -> generate
 *                                   \--(valid | retries exhausted)--> analyze -> advise
 */
export function buildPipeline(deps: PipelineDeps) {
  const { llm, onTrace } = deps;

  const timed = async <T>(step: string, label: string, fn: () => Promise<{ value: T; detail?: string; status?: TraceStep['status'] }>): Promise<T> => {
    const t0 = Date.now();
    onTrace({ step, label, status: 'running', at: t0 });
    try {
      const r = await fn();
      onTrace({ step, label, status: r.status ?? 'done', detail: r.detail, ms: Date.now() - t0, at: Date.now() });
      return r.value;
    } catch (e: any) {
      onTrace({ step, label, status: 'failed', detail: String(e?.message ?? e), ms: Date.now() - t0, at: Date.now() });
      throw e;
    }
  };

  const extract = async (s: S): Promise<Partial<S>> => {
    let used: EngineUsed = 'rules';
    let note = '';
    const wantLlm = s.engine !== 'rules' && (await llm.isAvailable());
    if (s.engine === 'llm' && !wantLlm) throw new Error('LLM engine requested but the model server is not reachable.');
    const model = await timed('extract', 'Process Extractor', async () => {
      if (wantLlm) {
        try {
          const m = await extractWithLlm(llm, s.text);
          if (m.nodes.length >= 2) {
            used = 'llm';
            return { value: m, detail: `${llm.model} via ${llm.provider}: ${m.nodes.length} elements` };
          }
          note = 'LLM returned no usable graph; fell back to rules engine. ';
        } catch (e: any) {
          if (s.engine === 'llm') throw e;
          note = `LLM failed (${String(e?.message ?? e).slice(0, 80)}); fell back to rules engine. `;
        }
      } else if (s.engine === 'auto') {
        note = 'No model server reachable; ';
      }
      const m = extractWithRules(s.text);
      return {
        value: m,
        status: note ? ('warn' as const) : ('done' as const),
        detail: `${note}rules engine: ${m.nodes.length} elements, ${m.actors.length} actors`,
      };
    });
    if (model.nodes.length < 2) throw new Error('Could not find any process steps in the input. Describe who does what, in order.');
    return { model, usedEngine: used, attempts: 0 };
  };

  const generate = async (s: S): Promise<Partial<S>> => {
    const xml = await timed('generate', 'BPMN XML Generator', async () => {
      const x = generateBpmn(s.model);
      return { value: x, detail: `${x.length.toLocaleString()} bytes, ${s.model.actors.length} lanes` };
    });
    return { xml };
  };

  const validate = async (s: S): Promise<Partial<S>> => {
    const res = await timed('validate', s.attempts ? `Validator (re-check ${s.attempts})` : 'Validator', async () => {
      const r = await validateBpmn(s.xml);
      const errs = r.issues.filter((i) => i.severity === 'error').length;
      return {
        value: r,
        status: r.valid ? ('done' as const) : ('warn' as const),
        detail: r.valid ? `BPMN 2.0 schema + rules OK${r.issues.length ? `, ${r.issues.length} warning(s)` : ''}` : `${errs} error(s) found`,
      };
    });
    return { issues: res.issues, valid: res.valid };
  };

  const repair = async (s: S): Promise<Partial<S>> => {
    const attempt = s.attempts + 1;
    const model = await timed('repair', `Repair loop (attempt ${attempt}/${MAX_REPAIRS})`, async () => {
      let m = s.model;
      let via = '';
      if (s.usedEngine === 'llm') {
        try {
          m = await repairWithLlm(llm, m, s.issues);
          via = 'LLM + ';
        } catch {
          /* deterministic repair below still runs */
        }
      }
      const r = repairModel(m, s.issues);
      return { value: r.model, status: 'warn' as const, detail: `${via}${r.actions.slice(0, 3).join(' ') || 'no change'}${r.actions.length > 3 ? ` (+${r.actions.length - 3} more)` : ''}` };
    });
    return { model, attempts: attempt };
  };

  const analyzeNode = async (s: S): Promise<Partial<S>> => {
    const findings = await timed('analyze', 'Bottleneck Analyzer', async () => {
      const f = analyze(s.model);
      return { value: f, detail: `${f.length} finding(s)` };
    });
    return { findings, metrics: computeMetrics(s.model) };
  };

  const adviseNode = async (s: S): Promise<Partial<S>> => {
    const out = await timed('advise', 'Improvement Advisor', async () => {
      const suggestions = advise(s.findings);
      let summary = defaultSummary(s);
      if (s.usedEngine === 'llm') {
        try {
          summary = (await summarizeWithLlm(llm, s.model, s.findings)) || summary;
        } catch {
          /* keep deterministic summary */
        }
      }
      return { value: { suggestions, summary }, detail: `${suggestions.length} suggestion(s)` };
    });
    return out;
  };

  const route = (s: S) => (s.valid || s.attempts >= MAX_REPAIRS ? 'analyze' : 'repair');

  return new StateGraph(State)
    .addNode('extract', extract)
    .addNode('generate', generate)
    .addNode('validate', validate)
    .addNode('repair', repair)
    .addNode('analyze', analyzeNode)
    .addNode('advise', adviseNode)
    .addEdge(START, 'extract')
    .addEdge('extract', 'generate')
    .addEdge('generate', 'validate')
    .addConditionalEdges('validate', route, { analyze: 'analyze', repair: 'repair' })
    .addEdge('repair', 'generate')
    .addEdge('analyze', 'advise')
    .addEdge('advise', END)
    .compile();
}

function defaultSummary(s: S): string {
  const m = s.metrics;
  const high = s.findings.filter((f) => f.severity === 'high').length;
  return (
    `"${s.model.title}" has ${m.tasks} steps across ${m.actors || 1} actor(s), ${m.decisionPoints} decision point(s) and ${m.handoffs} hand-off(s). ` +
    (s.findings.length
      ? `${s.findings.length} improvement opportunit${s.findings.length === 1 ? 'y was' : 'ies were'} found${high ? `, ${high} high priority` : ''}.`
      : 'No structural weaknesses were detected.')
  );
}

export async function runPipeline(deps: PipelineDeps, text: string, engine: EngineChoice): Promise<PipelineResult> {
  const graph = buildPipeline(deps);
  const s = await graph.invoke({ text, engine, attempts: 0 });
  return {
    model: s.model,
    xml: s.xml,
    issues: s.issues,
    valid: s.valid,
    repairs: s.attempts,
    engine: s.usedEngine,
    findings: s.findings,
    suggestions: s.suggestions,
    metrics: s.metrics,
    summary: s.summary,
  };
}
