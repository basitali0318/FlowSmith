import { Issue } from './types';

// bpmn-moddle@8 is CommonJS and ships no typings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BpmnModdle = require('bpmn-moddle');

const FLOW_NODE_TYPES = new Set([
  'bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:Task', 'bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ManualTask',
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway', 'bpmn:IntermediateCatchEvent',
  'bpmn:IntermediateThrowEvent', 'bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:BusinessRuleTask',
  'bpmn:ScriptTask', 'bpmn:SendTask', 'bpmn:ReceiveTask',
]);
const TASK_LIKE = (t: string) => /Task$|Activity$|SubProcess$/.test(t);

/**
 * Validates BPMN 2.0 XML in two layers:
 *  1. Schema layer - bpmn-moddle parses against the BPMN 2.0 meta-model (unknown elements,
 *     unresolved references, malformed XML).
 *  2. Rule layer - structural soundness rules that a modeller would flag.
 */
export async function validateBpmn(xml: string): Promise<{ valid: boolean; issues: Issue[] }> {
  const issues: Issue[] = [];
  let root: any;
  try {
    const moddle = new BpmnModdle();
    const res = await moddle.fromXML(xml);
    root = res.rootElement;
    for (const w of res.warnings ?? []) {
      issues.push({ severity: 'error', code: 'SCHEMA', message: String(w.message ?? w).split('\n')[0] });
    }
  } catch (e: any) {
    return { valid: false, issues: [{ severity: 'error', code: 'XML_PARSE', message: `Invalid BPMN XML: ${String(e?.message ?? e).split('\n')[0]}` }] };
  }

  const processes = (root.rootElements ?? []).filter((r: any) => r.$type === 'bpmn:Process');
  if (!processes.length) {
    issues.push({ severity: 'error', code: 'NO_PROCESS', message: 'The definitions contain no process.' });
  }

  const seen = new Set<string>();
  const shapeIds = new Set<string>();
  for (const d of root.diagrams ?? []) {
    for (const el of d.plane?.planeElement ?? []) if (el.bpmnElement?.id) shapeIds.add(el.bpmnElement.id);
  }

  for (const proc of processes) {
    const els: any[] = proc.flowElements ?? [];
    const nodes = els.filter((e) => FLOW_NODE_TYPES.has(e.$type));
    const flows = els.filter((e) => e.$type === 'bpmn:SequenceFlow');
    const byId = new Map<string, any>(nodes.map((n) => [n.id, n]));

    for (const e of els) {
      if (seen.has(e.id)) issues.push({ severity: 'error', code: 'DUPLICATE_ID', message: `Duplicate element id "${e.id}".`, elementId: e.id });
      seen.add(e.id);
    }

    const starts = nodes.filter((n) => n.$type === 'bpmn:StartEvent');
    const ends = nodes.filter((n) => n.$type === 'bpmn:EndEvent');
    if (!starts.length) issues.push({ severity: 'error', code: 'NO_START', message: 'Process has no start event.' });
    if (!ends.length) issues.push({ severity: 'error', code: 'NO_END', message: 'Process has no end event.' });

    const inc = new Map<string, any[]>();
    const out = new Map<string, any[]>();
    for (const f of flows) {
      if (!f.sourceRef || !f.targetRef || !byId.has(f.sourceRef.id) || !byId.has(f.targetRef.id)) {
        issues.push({ severity: 'error', code: 'BROKEN_FLOW', message: `Sequence flow "${f.id}" has a missing source or target.`, elementId: f.id });
        continue;
      }
      (out.get(f.sourceRef.id) ?? out.set(f.sourceRef.id, []).get(f.sourceRef.id)!).push(f);
      (inc.get(f.targetRef.id) ?? inc.set(f.targetRef.id, []).get(f.targetRef.id)!).push(f);
    }

    for (const n of nodes) {
      const i = inc.get(n.id)?.length ?? 0;
      const o = out.get(n.id)?.length ?? 0;
      const label = n.name ? `"${n.name}"` : `(${n.id})`;
      if (n.$type === 'bpmn:StartEvent' && i > 0) issues.push({ severity: 'error', code: 'START_HAS_INCOMING', message: `Start event ${label} must not have incoming flows.`, elementId: n.id });
      if (n.$type === 'bpmn:EndEvent' && o > 0) issues.push({ severity: 'error', code: 'END_HAS_OUTGOING', message: `End event ${label} must not have outgoing flows.`, elementId: n.id });
      if (n.$type !== 'bpmn:StartEvent' && i === 0) issues.push({ severity: 'error', code: 'NO_INCOMING', message: `${label} has no incoming flow (unreachable).`, elementId: n.id });
      if (n.$type !== 'bpmn:EndEvent' && o === 0) issues.push({ severity: 'error', code: 'NO_OUTGOING', message: `${label} has no outgoing flow (dead end).`, elementId: n.id });
      if (TASK_LIKE(n.$type) && !n.name) issues.push({ severity: 'warning', code: 'UNNAMED_TASK', message: `Task ${n.id} has no name.`, elementId: n.id });
      if (n.$type === 'bpmn:ExclusiveGateway' || n.$type === 'bpmn:ParallelGateway') {
        if (i + o >= 2 && i < 2 && o < 2) {
          issues.push({ severity: 'warning', code: 'GATEWAY_NO_BRANCH', message: `Gateway ${label} neither splits nor joins paths.`, elementId: n.id });
        }
        if (n.$type === 'bpmn:ExclusiveGateway' && o > 1) {
          const unlabeled = (out.get(n.id) ?? []).filter((f) => !f.name && !f.conditionExpression);
          if (unlabeled.length) {
            issues.push({ severity: 'error', code: 'XOR_UNLABELED', message: `Decision ${label} has ${unlabeled.length} branch(es) without a label or condition.`, elementId: n.id });
          }
        }
        if (n.$type === 'bpmn:ParallelGateway' && i > 1 && o > 1) {
          issues.push({ severity: 'warning', code: 'MIXED_GATEWAY', message: `Parallel gateway ${label} both joins and splits; use two gateways.`, elementId: n.id });
        }
      }
      if (n.$type === 'bpmn:ParallelGateway' && o === 1 && i === 1) {
        issues.push({ severity: 'warning', code: 'GATEWAY_PASS_THROUGH', message: `Parallel gateway ${label} has one entry and one exit.`, elementId: n.id });
      }
      if (!shapeIds.has(n.id)) issues.push({ severity: 'warning', code: 'NO_DI', message: `${label} has no diagram shape and will not be drawn.`, elementId: n.id });
    }

    // reachability from start events
    if (starts.length) {
      const reach = new Set<string>();
      const stack = starts.map((s: any) => s.id);
      while (stack.length) {
        const id = stack.pop()!;
        if (reach.has(id)) continue;
        reach.add(id);
        (out.get(id) ?? []).forEach((f) => stack.push(f.targetRef.id));
      }
      for (const n of nodes) {
        if (!reach.has(n.id) && (inc.get(n.id)?.length ?? 0) > 0) {
          issues.push({ severity: 'error', code: 'UNREACHABLE', message: `"${n.name ?? n.id}" cannot be reached from any start event.`, elementId: n.id });
        }
      }
    }
    // every node should be able to reach an end event
    if (ends.length) {
      const canEnd = new Set<string>();
      const stack = ends.map((s: any) => s.id);
      while (stack.length) {
        const id = stack.pop()!;
        if (canEnd.has(id)) continue;
        canEnd.add(id);
        (inc.get(id) ?? []).forEach((f) => stack.push(f.sourceRef.id));
      }
      for (const n of nodes) {
        if (!canEnd.has(n.id) && (out.get(n.id)?.length ?? 0) > 0) {
          issues.push({ severity: 'error', code: 'NO_PATH_TO_END', message: `"${n.name ?? n.id}" can never reach an end event (endless loop).`, elementId: n.id });
        }
      }
    }
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}
