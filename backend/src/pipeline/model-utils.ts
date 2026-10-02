import { NodeType, PFlow, PNode, ProcessModel } from './types';

const TYPE_ALIASES: Record<string, NodeType> = {
  start: 'start', startevent: 'start', begin: 'start',
  end: 'end', endevent: 'end', finish: 'end',
  task: 'task', usertask: 'task', servicetask: 'task', manualtask: 'task', activity: 'task', step: 'task',
  xor: 'xor', exclusive: 'xor', exclusivegateway: 'xor', gateway: 'xor', decision: 'xor',
  and: 'and', parallel: 'and', parallelgateway: 'and', fork: 'and', join: 'and',
};

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

export function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/**
 * Turns untrusted JSON (typically LLM output) into a structurally safe ProcessModel:
 * known node types, unique ids, string names, flows that reference existing nodes.
 * It does NOT fix semantic problems (dangling nodes, missing start/end) - that is the
 * validator + repair loop's job.
 */
export function normalizeModel(raw: any, fallbackTitle = 'Untitled process'): ProcessModel {
  const rawNodes: any[] = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const nodes: PNode[] = [];
  const idMap = new Map<string, string>();
  const used = new Set<string>();

  for (const [i, n] of rawNodes.entries()) {
    if (!n || typeof n !== 'object') continue;
    const type = TYPE_ALIASES[String(n.type ?? 'task').toLowerCase().replace(/[^a-z]/g, '')] ?? 'task';
    const origId = String(n.id ?? `n${i + 1}`);
    let id = `N_${slug(origId)}`;
    while (used.has(id)) id += '_';
    used.add(id);
    idMap.set(origId, id);
    const actor = typeof n.actor === 'string' && n.actor.trim() ? titleCase(clip(n.actor, 40)) : undefined;
    const kindRaw = String(n.kind ?? n.type ?? '').toLowerCase();
    nodes.push({
      id,
      type,
      name: clip(String(n.name ?? n.label ?? ''), 80),
      actor: type === 'task' || type === 'start' || type === 'end' ? actor : undefined,
      kind: type === 'task' ? (kindRaw.includes('service') ? 'service' : kindRaw.includes('user') ? 'user' : 'plain') : undefined,
    });
  }

  const flows: PFlow[] = [];
  const rawFlows: any[] = Array.isArray(raw?.flows) ? raw.flows : Array.isArray(raw?.edges) ? raw.edges : [];
  for (const f of rawFlows) {
    const from = idMap.get(String(f?.from ?? f?.source));
    const to = idMap.get(String(f?.to ?? f?.target));
    if (!from || !to) continue;
    const label = typeof f.label === 'string' && f.label.trim() ? clip(f.label, 40) : undefined;
    flows.push({ id: `F_${flows.length + 1}`, from, to, label });
  }

  const actors = Array.from(
    new Set([
      ...(Array.isArray(raw?.actors) ? raw.actors.map((a: any) => titleCase(clip(String(a), 40))) : []),
      ...nodes.map((n) => n.actor).filter((a): a is string => !!a),
    ]),
  ).filter(Boolean);

  return {
    title: clip(String(raw?.title ?? fallbackTitle), 80) || fallbackTitle,
    actors,
    nodes,
    flows,
  };
}

export function outgoing(m: ProcessModel, id: string): PFlow[] {
  return m.flows.filter((f) => f.from === id);
}
export function incoming(m: ProcessModel, id: string): PFlow[] {
  return m.flows.filter((f) => f.to === id);
}

export function cloneModel(m: ProcessModel): ProcessModel {
  return JSON.parse(JSON.stringify(m));
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this'].includes(t));
}

export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => B.has(t) && inter++);
  return inter / (A.size + B.size - inter);
}
