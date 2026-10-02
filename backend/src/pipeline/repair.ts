import { Issue, PFlow, ProcessModel } from './types';
import { cloneModel, incoming, outgoing } from './model-utils';

/**
 * Deterministic repair strategies keyed on validator issue codes. The LangGraph loop calls
 * this (optionally after an LLM repair proposal) and then regenerates + revalidates the XML.
 * Returns the repaired model and a human-readable list of what was changed.
 */
export function repairModel(input: ProcessModel, issues: Issue[]): { model: ProcessModel; actions: string[] } {
  const m = cloneModel(input);
  const actions: string[] = [];
  const codes = new Set(issues.map((i) => i.code));
  const nextId = (p: string) => {
    let i = 1;
    while (m.nodes.some((n) => n.id === `${p}${i}`)) i++;
    return `${p}${i}`;
  };
  const addFlow = (from: string, to: string, label?: string) => {
    if (m.flows.some((f) => f.from === from && f.to === to)) return;
    m.flows.push({ id: `R_${m.flows.length + 1}_${from}_${to}`.replace(/[^A-Za-z0-9_]/g, '_'), from, to, label });
  };

  // Drop flows pointing at nodes that do not exist; fix duplicate flow ids.
  if (codes.has('BROKEN_FLOW') || codes.has('SCHEMA') || codes.has('DUPLICATE_ID')) {
    const ids = new Set(m.nodes.map((n) => n.id));
    const before = m.flows.length;
    m.flows = m.flows.filter((f) => ids.has(f.from) && ids.has(f.to));
    if (m.flows.length !== before) actions.push(`Removed ${before - m.flows.length} flow(s) that referenced missing elements.`);
    const seen = new Set<string>();
    m.flows.forEach((f: PFlow) => {
      if (seen.has(f.id)) f.id = `${f.id}_${seen.size}`;
      seen.add(f.id);
    });
  }

  // Start / end events
  if (codes.has('NO_START') || !m.nodes.some((n) => n.type === 'start')) {
    const s = { id: nextId('S'), type: 'start' as const, name: 'Start' };
    m.nodes.unshift(s);
    const first = m.nodes.find((n) => n.id !== s.id && n.type !== 'start' && incoming(m, n.id).length === 0) ?? m.nodes.find((n) => n.id !== s.id && n.type !== 'start');
    if (first) addFlow(s.id, first.id);
    actions.push('Added a missing start event.');
  }
  if (codes.has('START_HAS_INCOMING')) {
    const before = m.flows.length;
    const starts = new Set(m.nodes.filter((n) => n.type === 'start').map((n) => n.id));
    m.flows = m.flows.filter((f) => !starts.has(f.to));
    actions.push(`Removed ${before - m.flows.length} flow(s) entering a start event.`);
  }
  if (codes.has('END_HAS_OUTGOING')) {
    const ends = new Set(m.nodes.filter((n) => n.type === 'end').map((n) => n.id));
    const before = m.flows.length;
    m.flows = m.flows.filter((f) => !ends.has(f.from));
    actions.push(`Removed ${before - m.flows.length} flow(s) leaving an end event.`);
  }

  // Gateways that neither split nor join: splice them out
  for (const g of m.nodes.filter((n) => (n.type === 'xor' || n.type === 'and'))) {
    const i = incoming(m, g.id);
    const o = outgoing(m, g.id);
    if (i.length === 1 && o.length === 1 && issues.some((x) => x.elementId === g.id && /GATEWAY/.test(x.code))) {
      m.flows = m.flows.filter((f) => f !== i[0] && f !== o[0]);
      addFlow(i[0].from, o[0].to, i[0].label ?? o[0].label);
      m.nodes = m.nodes.filter((n) => n.id !== g.id);
      actions.push(`Removed pass-through gateway "${g.name || g.id}".`);
    }
  }

  // Dead ends -> connect to an end event
  const dead = m.nodes.filter((n) => n.type !== 'end' && outgoing(m, n.id).length === 0);
  if (dead.length) {
    let end = m.nodes.find((n) => n.type === 'end');
    if (!end) {
      end = { id: nextId('E'), type: 'end', name: 'Process completed' };
      m.nodes.push(end);
      actions.push('Added a missing end event.');
    }
    for (const d of dead) {
      addFlow(d.id, end.id, d.type === 'xor' ? 'No' : undefined);
      actions.push(`Connected dead-end "${d.name || d.id}" to "${end.name}".`);
    }
  }

  // Orphans (no incoming) -> connect from the previous node in document order, or the start event
  const start = m.nodes.find((n) => n.type === 'start')!;
  for (const n of m.nodes) {
    if (n.type === 'start' || incoming(m, n.id).length > 0) continue;
    const idx = m.nodes.indexOf(n);
    const prev = [...m.nodes.slice(0, idx)].reverse().find((p) => p.type !== 'end' && p.id !== n.id) ?? start;
    addFlow(prev.id, n.id);
    actions.push(`Connected unreachable "${n.name || n.id}" after "${prev.name || prev.id}".`);
  }

  // Missing end event after the above (graph with only loops)
  if (!m.nodes.some((n) => n.type === 'end')) {
    const last = m.nodes[m.nodes.length - 1];
    const e = { id: nextId('E'), type: 'end' as const, name: 'Process completed' };
    m.nodes.push(e);
    addFlow(last.id, e.id);
    actions.push('Added a missing end event.');
  }

  // Unlabeled decision branches
  for (const g of m.nodes.filter((n) => n.type === 'xor')) {
    const outs = outgoing(m, g.id);
    if (outs.length > 1 && outs.some((f) => !f.label)) {
      const used = new Set(outs.map((f) => f.label).filter(Boolean));
      let k = 1;
      for (const f of outs.filter((f) => !f.label)) {
        const label = outs.length === 2 ? (!used.has('Yes') ? 'Yes' : !used.has('No') ? 'No' : `Path ${k}`) : `Path ${k}`;
        used.add(label);
        f.label = label;
        k++;
      }
      actions.push(`Labelled the branches of decision "${g.name || g.id}".`);
    }
  }

  // Nodes that cannot reach an end (cycles with no exit): add an exit from the last node of the cycle
  const canEnd = new Set<string>();
  const stack = m.nodes.filter((n) => n.type === 'end').map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (canEnd.has(id)) continue;
    canEnd.add(id);
    incoming(m, id).forEach((f) => stack.push(f.from));
  }
  const trapped = m.nodes.filter((n) => !canEnd.has(n.id) && n.type !== 'end');
  if (trapped.length) {
    const end = m.nodes.find((n) => n.type === 'end')!;
    const exit = trapped[trapped.length - 1];
    addFlow(exit.id, end.id, exit.type === 'xor' ? 'Done' : undefined);
    actions.push(`Added an exit from the loop at "${exit.name || exit.id}".`);
  }

  for (const n of m.nodes) if (n.type === 'task' && !n.name) n.name = 'Unnamed step';
  return { model: m, actions };
}
