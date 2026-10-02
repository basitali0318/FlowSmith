import { useState } from 'react';
import type { Finding, Issue, ProcessRec, Suggestion, TraceStep } from '../types';

const CAT: Record<string, string> = {
  bottleneck: 'Bottleneck', redundancy: 'Redundant step', 'missing-exception': 'Missing exception path', handoff: 'Hand-offs', complexity: 'Complexity',
};

interface Props {
  rec: ProcessRec;
  issues: Issue[];
  valid: boolean;
  onFocus: (ids: string[]) => void;
  focused: string[];
}

export default function Insights({ rec, issues, valid, onFocus, focused }: Props) {
  const [tab, setTab] = useState<'insights' | 'validation' | 'pipeline'>('insights');
  const r = rec.result;
  const errors = issues.filter((i) => i.severity === 'error').length;

  return (
    <aside className="insights card">
      <div className="tabs" role="tablist">
        {(['insights', 'validation', 'pipeline'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'insights' ? 'Insights' : t === 'validation' ? `Validation${issues.length ? ` (${issues.length})` : ''}` : 'Pipeline'}
          </button>
        ))}
      </div>

      {tab === 'insights' && r && (
        <div className="tab-body">
          <p className="summary">{r.summary}</p>
          <div className="metrics">
            <Metric n={r.metrics.tasks} l="Steps" />
            <Metric n={r.metrics.actors} l="Actors" />
            <Metric n={r.metrics.decisionPoints} l="Decisions" />
            <Metric n={r.metrics.handoffs} l="Hand-offs" />
          </div>

          <h3>Findings <span className="count">{r.findings.length}</span></h3>
          {r.findings.length === 0 && <p className="muted">No bottlenecks, redundancies or missing exception paths detected.</p>}
          {r.findings.map((f) => <FindingCard key={f.id} f={f} active={f.nodeIds.length > 0 && f.nodeIds.every((i) => focused.includes(i))} onFocus={onFocus} />)}

          <h3>Suggested improvements <span className="count">{r.suggestions.length}</span></h3>
          {r.suggestions.map((s) => <SuggestionCard key={s.id} s={s} findings={r.findings} onFocus={onFocus} />)}
        </div>
      )}

      {tab === 'validation' && (
        <div className="tab-body">
          <div className={`badge-row ${valid ? 'ok' : 'bad'}`}>
            {valid ? '✓ Valid BPMN 2.0' : `✕ ${errors} error${errors === 1 ? '' : 's'} remain`}
            {r && r.repairs > 0 && <span> · auto-repaired in {r.repairs} {r.repairs === 1 ? 'pass' : 'passes'}</span>}
          </div>
          <p className="muted">Checked with bpmn-moddle against the BPMN 2.0 meta-model plus structural rules (start/end events, dead ends, reachability, gateway labels).</p>
          {issues.length === 0 && <p className="ok-text">No issues found.</p>}
          {issues.map((i, k) => (
            <button key={k} className={`issue ${i.severity}`} onClick={() => i.elementId && onFocus([i.elementId])}>
              <span className="dot" />{i.message}
            </button>
          ))}
        </div>
      )}

      {tab === 'pipeline' && <TraceList trace={rec.trace} />}
    </aside>
  );
}

function Metric({ n, l }: { n: number; l: string }) {
  return <div className="metric"><b>{n}</b><span>{l}</span></div>;
}

function FindingCard({ f, active, onFocus }: { f: Finding; active: boolean; onFocus: (ids: string[]) => void }) {
  return (
    <button className={`finding ${f.severity}${active ? ' active' : ''}`} onClick={() => onFocus(f.nodeIds)} disabled={!f.nodeIds.length}>
      <div className="row"><span className={`sev ${f.severity}`}>{f.severity}</span><span className="cat">{CAT[f.category] ?? f.category}</span></div>
      <strong>{f.title}</strong>
      <p>{f.detail}</p>
    </button>
  );
}

function SuggestionCard({ s, findings, onFocus }: { s: Suggestion; findings: Finding[]; onFocus: (ids: string[]) => void }) {
  const ids = findings.filter((f) => s.findingIds.includes(f.id)).flatMap((f) => f.nodeIds);
  return (
    <button className="suggestion" onClick={() => onFocus(ids)} disabled={!ids.length}>
      <strong>{s.title}</strong>
      <p>{s.rationale}</p>
      <div className="row"><span className="tag">Impact: {s.impact}</span><span className="tag">Effort: {s.effort}</span></div>
    </button>
  );
}

export function TraceList({ trace }: { trace: TraceStep[] }) {
  if (!trace.length) return <div className="tab-body"><p className="muted">Waiting for the pipeline to start…</p></div>;
  return (
    <div className="tab-body">
      <ol className="trace">
        {trace.map((t, i) => (
          <li key={i} className={t.status}>
            <span className="ico" aria-hidden="true">{t.status === 'running' ? <i className="spin" /> : t.status === 'failed' ? '✕' : t.status === 'warn' ? '!' : '✓'}</span>
            <div>
              <strong>{t.label}</strong>{t.ms !== undefined && <em>{t.ms} ms</em>}
              {t.detail && <p>{t.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
