import { LlmService } from '../../llm/llm.service';
import { Finding, Issue, ProcessModel } from '../types';
import { normalizeModel } from '../model-utils';

export const PROCESS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    actors: { type: 'array', items: { type: 'string' } },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['start', 'end', 'task', 'xor', 'and'] },
          name: { type: 'string' },
          actor: { type: 'string' },
        },
        required: ['id', 'type', 'name'],
      },
    },
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
  },
  required: ['title', 'actors', 'nodes', 'flows'],
};

const EXTRACT_SYSTEM = `You are a business-process analyst. Convert the user's process description (SOP, meeting notes or free text) into a structured process graph.
Return ONLY JSON with this shape:
{"title": string, "actors": string[], "nodes": [{"id": string, "type": "start"|"end"|"task"|"xor"|"and", "name": string, "actor"?: string}], "flows": [{"from": id, "to": id, "label"?: string}]}
Rules:
- Exactly one "start" node; one "end" node per distinct outcome (e.g. approved, rejected).
- "task": an activity, named with a short verb phrase ("Review expense report"); set "actor" to the role that performs it ("Manager", "Finance", "System").
- "xor": an exclusive decision; its name is a yes/no question; every outgoing flow MUST have a label ("Yes"/"No" or the condition).
- "and": parallel split or join (use one node to split and another to join).
- Every node except start must have an incoming flow; every node except end must have an outgoing flow.
- Rework or loops are flows back to an earlier node. Do not invent steps that are not implied by the text.`;

export async function extractWithLlm(llm: LlmService, text: string): Promise<ProcessModel> {
  const raw = await llm.json(EXTRACT_SYSTEM, `Process description:\n"""\n${text}\n"""`, PROCESS_SCHEMA);
  return normalizeModel(raw);
}

export async function repairWithLlm(llm: LlmService, model: ProcessModel, issues: Issue[]): Promise<ProcessModel> {
  const slim = {
    title: model.title,
    actors: model.actors,
    nodes: model.nodes.map(({ id, type, name, actor }) => ({ id, type, name, actor })),
    flows: model.flows.map(({ from, to, label }) => ({ from, to, label })),
  };
  const raw = await llm.json(
    `${EXTRACT_SYSTEM}\nYou are repairing a process graph that failed BPMN validation. Fix ONLY what the issues describe and keep everything else unchanged. Return the complete corrected JSON.`,
    `Process graph:\n${JSON.stringify(slim)}\n\nValidation issues:\n${issues.filter((i) => i.severity === 'error').map((i) => `- ${i.message}`).join('\n')}`,
    PROCESS_SCHEMA,
  );
  return normalizeModel(raw, model.title);
}

export async function summarizeWithLlm(llm: LlmService, model: ProcessModel, findings: Finding[]): Promise<string> {
  const brief = model.nodes.filter((n) => n.type === 'task').map((n) => `${n.actor ?? '?'}: ${n.name}`).join('; ');
  return (
    await llm.text(
      'You are a process-improvement consultant. In 2-3 plain sentences, summarise how this process works and its most important weakness. No lists, no markdown.',
      `Process "${model.title}". Steps: ${brief}\nFindings: ${findings.map((f) => f.title).join(' | ') || 'none'}`,
    )
  ).trim();
}
