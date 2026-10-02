import { Finding, Suggestion } from './types';

/** Maps findings to concrete, prioritised improvement suggestions. */
export function advise(findings: Finding[]): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (s: Omit<Suggestion, 'id'>) => out.push({ ...s, id: `S${out.length + 1}` });

  for (const f of findings) {
    switch (f.category) {
      case 'bottleneck':
        if (/Sequential approvals/.test(f.title)) {
          add({
            title: 'Run the approvals in parallel or merge them',
            rationale: 'Independent checks do not need to wait for each other. Use a parallel gateway, or a single approval with a delegation-of-authority rule.',
            impact: 'high', effort: 'low', findingIds: [f.id],
          });
        } else if (/carries/.test(f.title)) {
          add({
            title: 'Redistribute work or add a backup owner',
            rationale: 'Delegate low-risk steps to another role, define a deputy, or automate routine steps so one actor is not the single point of failure.',
            impact: 'high', effort: 'medium', findingIds: [f.id],
          });
        } else {
          add({
            title: 'Add capacity or a queue policy at the convergence point',
            rationale: 'Introduce a service-level target (e.g. respond within 1 business day) and visible queue limits where several paths merge.',
            impact: 'medium', effort: 'medium', findingIds: [f.id],
          });
        }
        break;
      case 'redundancy':
        add({
          title: /twice in a row/.test(f.title) ? 'Combine consecutive verification steps' : 'Remove or merge the duplicated step',
          rationale: 'Repeated work adds cycle time without adding control. Keep one step and give it a clear owner and acceptance criteria.',
          impact: 'medium', effort: 'low', findingIds: [f.id],
        });
        break;
      case 'missing-exception':
        if (/only one outcome/.test(f.title)) {
          add({ title: 'Model the second outcome of the decision', rationale: 'Add the "else" path so the diagram is executable and auditable.', impact: 'high', effort: 'low', findingIds: [f.id] });
        } else if (/No decision points/.test(f.title)) {
          add({ title: 'Add accept / reject decisions after approvals and checks', rationale: 'Show what happens on refusal, with a rejection end event and a notification to the requester.', impact: 'high', effort: 'low', findingIds: [f.id] });
        } else if (/rework loop/.test(f.title)) {
          add({ title: 'Add a rework loop and an escalation timer', rationale: 'Return incomplete items to the requester with a reason, and escalate cases that wait longer than an agreed limit.', impact: 'medium', effort: 'medium', findingIds: [f.id] });
        } else {
          add({ title: 'Add an explicit rejection / failure branch', rationale: 'Define who is informed, whether the case can be resubmitted, and which end state applies.', impact: 'high', effort: 'low', findingIds: [f.id] });
        }
        break;
      case 'handoff':
        add({
          title: 'Reduce hand-offs by consolidating ownership',
          rationale: 'Let one role own contiguous steps end-to-end, or add a shared status board so hand-offs are not silent waits.',
          impact: 'medium', effort: 'medium', findingIds: [f.id],
        });
        break;
      case 'complexity':
        add({
          title: 'Split into sub-processes or parallelise independent steps',
          rationale: 'Group related steps into a collapsed sub-process and run independent work simultaneously to shorten the critical path.',
          impact: 'medium', effort: 'high', findingIds: [f.id],
        });
        break;
    }
  }
  const w = { high: 0, medium: 1, low: 2 } as const;
  const e = { low: 0, medium: 1, high: 2 } as const;
  return out.sort((a, b) => w[a.impact] - w[b.impact] || e[a.effort] - e[b.effort]).map((s, i) => ({ ...s, id: `S${i + 1}` }));
}
