import { Finding, Metrics, ProcessModel } from './types';
import { incoming, outgoing, similarity } from './model-utils';

const APPROVAL_RE = /\b(approve|review|verify|validate|check|sign|authori[sz]e|inspect|audit|confirm)\b/i;
const APPROVER_RE = /\b(approve|review|sign|authori[sz]e|countersign)\b/i;
const ROUTING_RE = /exceed|above|below|greater|less than|more than|threshold|amount|value|total|priority|type|category|urgent|high|low|size|region/i;
const RISKY_RE = /\b(approve|review|verify|validate|check|payment|pay|submit|inspect|audit|authori[sz]e|screen|assess)\b/i;
const FAIL_RE = /\b(reject|declin|den(y|ied)|cancel|fail|invalid|error|escalat|rework|return|incomplete|abort)/i;

export function computeMetrics(m: ProcessModel): Metrics {
  const tasks = m.nodes.filter((n) => n.type === 'task');
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const handoffs = m.flows.filter((f) => {
    const a = byId.get(f.from)?.actor;
    const b = byId.get(f.to)?.actor;
    return a && b && a !== b;
  }).length;

  // longest path (tasks) ignoring loop edges
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const longest = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = byId.get(id)!;
    const best = Math.max(0, ...outgoing(m, id).map((f) => longest(f.to)));
    visiting.delete(id);
    const v = best + (n.type === 'task' ? 1 : 0);
    memo.set(id, v);
    return v;
  };
  const starts = m.nodes.filter((n) => n.type === 'start');
  return {
    tasks: tasks.length,
    gateways: m.nodes.filter((n) => n.type === 'xor' || n.type === 'and').length,
    actors: new Set(tasks.map((t) => t.actor).filter(Boolean)).size,
    handoffs,
    decisionPoints: m.nodes.filter((n) => n.type === 'xor').length,
    longestPath: Math.max(0, ...starts.map((s) => longest(s.id))),
  };
}

export function analyze(m: ProcessModel): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'id'>) => findings.push({ ...f, id: `F${findings.length + 1}` });
  const tasks = m.nodes.filter((n) => n.type === 'task');
  const byId = new Map(m.nodes.map((n) => [n.id, n]));

  /* ---- bottlenecks ---- */
  // 1. workload concentration
  const perActor = new Map<string, string[]>();
  tasks.forEach((t) => t.actor && perActor.set(t.actor, [...(perActor.get(t.actor) ?? []), t.id]));
  if (tasks.length >= 5) {
    for (const [actor, ids] of perActor) {
      const share = ids.length / tasks.length;
      if (share >= 0.5 && perActor.size > 1) {
        add({
          category: 'bottleneck',
          severity: share >= 0.65 ? 'high' : 'medium',
          title: `${actor} carries ${Math.round(share * 100)}% of all steps`,
          detail: `${ids.length} of ${tasks.length} tasks sit with ${actor}. Any absence or backlog there stalls the whole process.`,
          nodeIds: ids,
        });
      }
    }
  }
  // 2. convergence points
  for (const n of m.nodes) {
    const inc = incoming(m, n.id);
    if (n.type === 'task' && inc.length >= 3) {
      add({
        category: 'bottleneck',
        severity: 'medium',
        title: `"${n.name}" is a convergence point`,
        detail: `${inc.length} different paths feed into this step, so work queues up here.`,
        nodeIds: [n.id],
      });
    }
  }
  // 3. consecutive approvals
  for (const n of tasks) {
    if (!APPROVER_RE.test(n.name)) continue;
    const next = outgoing(m, n.id).map((f) => byId.get(f.to)).find((x) => x?.type === 'task' && APPROVER_RE.test(x.name) && x.actor !== n.actor);
    if (next) {
      add({
        category: 'bottleneck',
        severity: 'medium',
        title: `Sequential approvals: "${n.name}" → "${next.name}"`,
        detail: 'Back-to-back checks run one after another and add waiting time at each hand-over.',
        nodeIds: [n.id, next.id],
      });
    }
  }

  /* ---- redundancy ---- */
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      const s = similarity(a.name, b.name);
      if (s >= 0.75 || (a.name.toLowerCase() === b.name.toLowerCase())) {
        add({
          category: 'redundancy',
          severity: 'medium',
          title: `Possible duplicate step: "${a.name}" / "${b.name}"`,
          detail: `These two steps are almost identical${a.actor !== b.actor ? ` but owned by ${a.actor ?? 'nobody'} and ${b.actor ?? 'nobody'}` : ''}. Merge them or make the difference explicit.`,
          nodeIds: [a.id, b.id],
        });
      }
    }
  }
  for (const n of tasks) {
    const next = outgoing(m, n.id).map((f) => byId.get(f.to)).find((x) => x?.type === 'task');
    if (next && n.actor && n.actor === next.actor && /\b(check|verify|validate|review)\b/i.test(n.name) && /\b(check|verify|validate|review)\b/i.test(next.name)) {
      add({
        category: 'redundancy',
        severity: 'low',
        title: `${n.actor} verifies twice in a row`,
        detail: `"${n.name}" is immediately followed by "${next.name}" by the same actor; consider combining them.`,
        nodeIds: [n.id, next.id],
      });
    }
  }

  /* ---- missing exception paths ---- */
  for (const g of m.nodes.filter((n) => n.type === 'xor')) {
    const outs = outgoing(m, g.id);
    const labels = outs.map((f) => (f.label ?? '').toLowerCase());
    const targets = outs.map((f) => byId.get(f.to));
    const reaches = (from: string, to: string) => {
      const seen = new Set<string>();
      const st = [from];
      while (st.length) {
        const id = st.pop()!;
        if (id === to) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        outgoing(m, id).forEach((f) => st.push(f.to));
      }
      return false;
    };
    const loopsBack = outs.some((f) => reaches(f.to, g.id));
    const endsFrom = (id: string) => {
      const seen = new Set<string>();
      const found = new Set<string>();
      const st = [id];
      while (st.length) {
        const cur = st.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (byId.get(cur)?.type === 'end') found.add(cur);
        outgoing(m, cur).forEach((f) => st.push(f.to));
      }
      return [...found].sort().join(',');
    };
    const distinctOutcomes = new Set(outs.map((f) => endsFrom(f.to))).size > 1;
    const hasFailure = loopsBack || distinctOutcomes || outs.some((f, i) => FAIL_RE.test(f.label ?? '') || FAIL_RE.test(targets[i]?.name ?? '') || targets[i]?.type === 'end');
    if (outs.length < 2) {
      add({ category: 'missing-exception', severity: 'high', title: `Decision "${g.name}" has only one outcome`, detail: 'A decision needs at least two outcomes; otherwise it is just a step.', nodeIds: [g.id] });
    } else if (!hasFailure && !ROUTING_RE.test(g.name) && labels.every((l) => /yes|no|else|otherwise/.test(l) || l === '')) {
      add({
        category: 'missing-exception',
        severity: 'medium',
        title: `No failure path after "${g.name}"`,
        detail: 'Both outcomes continue the normal flow. What happens when the check fails, is rejected or needs rework?',
        nodeIds: [g.id],
      });
    }
  }
  const decisions = m.nodes.filter((n) => n.type === 'xor').length;
  const risky = tasks.filter((t) => RISKY_RE.test(t.name));
  if (risky.length && decisions === 0) {
    add({
      category: 'missing-exception',
      severity: 'high',
      title: 'No decision points around approvals or checks',
      detail: `Steps such as "${risky[0].name}" can fail or be refused, but the process models only the happy path.`,
      nodeIds: risky.map((t) => t.id),
    });
  }
  if (tasks.length >= 4 && !m.flows.some((f) => /rework|retry|return|resubmit/i.test(f.label ?? ''))) {
    const endCount = m.nodes.filter((n) => n.type === 'end').length;
    if (endCount === 1 && decisions > 0) {
      add({
        category: 'missing-exception',
        severity: 'low',
        title: 'No rework loop or escalation path',
        detail: 'Nothing sends work back for correction and nothing escalates a stalled case (e.g. a timeout after N days).',
        nodeIds: [],
      });
    }
  }

  /* ---- handoffs ---- */
  const metrics = computeMetrics(m);
  const taskFlows = m.flows.filter((f) => byId.get(f.from)?.type === 'task' && byId.get(f.to)?.type === 'task').length;
  if (metrics.handoffs >= 4 && taskFlows > 0 && metrics.handoffs / Math.max(1, m.flows.length) >= 0.35) {
    const ids = new Set<string>();
    m.flows.forEach((f) => {
      const a = byId.get(f.from);
      const b = byId.get(f.to);
      if (a?.actor && b?.actor && a.actor !== b.actor) {
        ids.add(a.id);
        ids.add(b.id);
      }
    });
    add({
      category: 'handoff',
      severity: metrics.handoffs >= 6 ? 'high' : 'medium',
      title: `${metrics.handoffs} hand-offs between ${metrics.actors} actors`,
      detail: 'Every hand-off adds waiting time and a chance for information to get lost. Look for steps that one actor could finish end-to-end.',
      nodeIds: [...ids],
    });
  }

  /* ---- complexity ---- */
  if (metrics.longestPath >= 10) {
    add({
      category: 'complexity',
      severity: metrics.longestPath >= 14 ? 'high' : 'low',
      title: `Long critical path (${metrics.longestPath} steps)`,
      detail: 'The longest route through the process has many sequential steps. Parallelise independent work or split into sub-processes.',
      nodeIds: [],
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((a, b) => order[a.severity] - order[b.severity]).map((f, i) => ({ ...f, id: `F${i + 1}` }));
}
