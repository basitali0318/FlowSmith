import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Health, Issue, ProcessListItem, ProcessRec, Sample } from '../types';
import BpmnCanvas, { CanvasHandle } from './BpmnCanvas';
import Insights, { TraceList } from './Insights';
import Logo from './Logo';

const STEPS = ['Extract', 'Generate', 'Validate', 'Analyze', 'Advise'];

function download(name: string, data: Blob | string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function svgToPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('render failed')); img.src = url; });
    const scale = 2;
    const c = document.createElement('canvas');
    c.width = (img.width || 1200) * scale;
    c.height = (img.height || 800) * scale;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('png failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function Workspace({ user, health, onLogout }: { user: string; health: Health | null; onLogout: () => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [engine, setEngine] = useState('auto');
  const [history, setHistory] = useState<ProcessListItem[]>([]);
  const [rec, setRec] = useState<ProcessRec | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [valid, setValid] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [focus, setFocus] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const canvas = useRef<CanvasHandle>(null);
  const poll = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshHistory = useCallback(() => api.list().then(setHistory).catch(() => undefined), []);

  useEffect(() => {
    api.samples().then(setSamples).catch(() => undefined);
    refreshHistory();
    return () => window.clearTimeout(poll.current);
  }, [refreshHistory]);

  const notify = (m: string) => { setToast(m); window.setTimeout(() => setToast(''), 2600); };
  const onCanvasError = useCallback((m: string) => setError(m), []);
  const onDirty = useCallback(() => setDirty(true), []);

  const adopt = useCallback((p: ProcessRec) => {
    setRec(p);
    if (p.result) {
      setXml(p.result.xml);
      setIssues(p.result.issues);
      setValid(p.result.valid);
      setDirty(false);
    }
  }, []);

  const track = useCallback((id: string) => {
    window.clearTimeout(poll.current);
    const tick = async () => {
      try {
        const p = await api.get(id);
        setRec(p);
        if (p.status === 'done') { adopt(p); setBusy(false); refreshHistory(); return; }
        if (p.status === 'failed') { setError(p.error || 'Generation failed.'); setBusy(false); refreshHistory(); return; }
        poll.current = window.setTimeout(tick, 700);
      } catch (e: any) {
        setError(e.message); setBusy(false);
        if (e instanceof ApiError && e.status === 401) onLogout();
      }
    };
    tick();
  }, [adopt, onLogout, refreshHistory]);

  async function generate() {
    setError('');
    if (!file && text.trim().length < 20) { setError('Describe the process in a few sentences, pick a sample, or upload a document.'); return; }
    setBusy(true);
    setFocus([]);
    setXml(null);
    setRec({ id: '', title: 'Generating…', status: 'queued', trace: [], createdAt: '', engineChoice: engine });
    try {
      const r = await api.create(text, engine, file);
      if (r.record) {
        // finished inside the request (serverless hosting) - no polling needed
        setRec(r.record);
        if (r.record.status === 'failed') setError(r.record.error || 'Generation failed.');
        else adopt(r.record);
        setBusy(false);
        refreshHistory();
      } else track(r.id);
    } catch (e: any) {
      setBusy(false); setRec(null); setError(e.message);
      if (e instanceof ApiError && e.status === 401) onLogout();
    }
  }

  async function open(id: string) {
    setError(''); setFocus([]);
    try { const p = await api.get(id); adopt(p); if (p.status === 'running' || p.status === 'queued') { setBusy(true); track(id); } } catch (e: any) { setError(e.message); }
  }

  async function save() {
    if (!rec?.id || !canvas.current) return;
    try {
      const out = await canvas.current.getXml();
      const v = await api.saveXml(rec.id, out);
      setIssues(v.issues); setValid(v.valid); setDirty(false);
      notify(v.valid ? 'Saved - diagram is valid' : 'Saved - validation errors remain');
    } catch (e: any) { setError(e.message); }
  }

  async function remove(id: string) {
    await api.remove(id).catch(() => undefined);
    if (rec?.id === id) { setRec(null); setXml(null); }
    refreshHistory();
  }

  async function exportAs(kind: 'bpmn' | 'svg' | 'png') {
    setExportOpen(false);
    if (!canvas.current) return;
    const base = (rec?.title || 'process').replace(/[^\w\-]+/g, '_');
    try {
      if (kind === 'bpmn') download(`${base}.bpmn`, await canvas.current.getXml(), 'application/xml');
      else if (kind === 'svg') download(`${base}.svg`, await canvas.current.getSvg(), 'image/svg+xml');
      else download(`${base}.png`, await svgToPng(await canvas.current.getSvg()));
    } catch (e: any) { setError(`Export failed: ${e.message}`); }
  }

  function onFile(f: File | null) {
    if (f && f.size > 4 * 1024 * 1024) { setError('File is larger than 4 MB.'); return; }
    setFile(f);
    if (f) setError('');
  }

  const running = busy && rec && rec.status !== 'done';
  const activeStep = useMemo(() => {
    const t = rec?.trace ?? [];
    const names = ['extract', 'generate', 'validate', 'analyze', 'advise'];
    const last = [...t].reverse().find((x) => names.includes(x.step));
    return last ? names.indexOf(last.step) : -1;
  }, [rec]);

  const eng = health?.engine;

  return (
    <div className="app">
      <header className="topbar">
        <Logo small />
        <div className="grow" />
        {eng && (
          <span className={`pill ${eng.mode}`} title={eng.mode === 'llm' ? 'Open-source model server reachable' : 'No model server reachable - using deterministic rules engine'}>
            <i /> {eng.mode === 'llm' ? `${eng.model} · ${eng.provider}` : 'Rules engine (offline)'}
          </span>
        )}
        <span className="user">{user}</span>
        <button className="btn ghost" onClick={onLogout}>Sign out</button>
      </header>

      <div className={`layout${wide ? ' wide' : ''}`}>
        <section className="left">
          <div className="card">
            <h2>Describe your process</h2>
            <div className="chips" aria-label="Sample inputs">
              {samples.map((s) => (
                <button key={s.id} className="chip" onClick={() => { setText(s.text); setFile(null); }} title={`${s.kind} sample`}>{s.title}</button>
              ))}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste an SOP, meeting notes or a plain description. e.g. 'The employee submits an expense report. The manager reviews it. If the amount exceeds $500, the director also approves it...'"
              rows={10}
              maxLength={15000}
              aria-label="Process description"
            />
            <div className="file-row">
              <input ref={fileInput} type="file" accept=".txt,.md,.docx,.pdf" hidden onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
              <button className="btn ghost sm" onClick={() => fileInput.current?.click()}>Upload SOP (.docx, .pdf, .txt)</button>
              {file && <span className="file">{file.name}<button aria-label="Remove file" onClick={() => setFile(null)}>×</button></span>}
            </div>
            <div className="gen-row">
              <label className="select">
                Engine
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  <option value="auto">Auto (LLM, fallback rules)</option>
                  <option value="llm">LLM only</option>
                  <option value="rules">Rules engine</option>
                </select>
              </label>
              <button className="btn primary grow" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate BPMN'}</button>
            </div>
            {error && <div className="alert error" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError('')}>×</button></div>}
          </div>

          <div className="card history">
            <h2>Recent diagrams</h2>
            {history.length === 0 && <p className="muted">Nothing yet. Generate your first diagram.</p>}
            <ul>
              {history.map((h) => (
                <li key={h.id} className={rec?.id === h.id ? 'on' : ''}>
                  <button className="open" onClick={() => open(h.id)}>
                    <strong>{h.title}</strong>
                    <span>{new Date(h.createdAt).toLocaleString()} · {h.status}{h.engine ? ` · ${h.engine}` : ''}</span>
                  </button>
                  <button className="del" aria-label={`Delete ${h.title}`} onClick={() => remove(h.id)}>×</button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="center">
          <div className="card stage">
            <div className="stage-head">
              <div className="title">
                <h2>{rec?.title ?? 'BPMN diagram'}</h2>
                {rec?.result && (
                  <>
                    <span className={`badge ${valid ? 'ok' : 'bad'}`}>{valid ? 'Valid BPMN 2.0' : 'Has errors'}</span>
                    <span className="badge neutral">{rec.result.engine === 'llm' ? 'LLM' : 'Rules'}{rec.result.repairs ? ` · ${rec.result.repairs} auto-repair` : ''}</span>
                  </>
                )}
              </div>
              <div className="tools">
                <button className="btn ghost sm" onClick={() => canvas.current?.zoom(-0.2)} aria-label="Zoom out" disabled={!xml}>−</button>
                <button className="btn ghost sm" onClick={() => canvas.current?.zoom(0.2)} aria-label="Zoom in" disabled={!xml}>+</button>
                <button className="btn ghost sm" onClick={() => { canvas.current?.fit(); }} disabled={!xml}>Fit</button>
                <button className="btn ghost sm" onClick={() => { setWide((w) => !w); window.setTimeout(() => canvas.current?.fit(), 60); }} aria-pressed={wide} title="Hide side panels for a larger canvas">{wide ? 'Collapse' : 'Expand'}</button>
                <button className="btn sm" onClick={save} disabled={!dirty}>{dirty ? 'Save edits' : 'Saved'}</button>
                <div className="menu">
                  <button className="btn primary sm" onClick={() => setExportOpen((o) => !o)} disabled={!xml} aria-haspopup="menu" aria-expanded={exportOpen}>Export ▾</button>
                  {exportOpen && (
                    <div className="dropdown" role="menu">
                      <button role="menuitem" onClick={() => exportAs('bpmn')}>BPMN 2.0 (.bpmn)</button>
                      <button role="menuitem" onClick={() => exportAs('svg')}>Image (.svg)</button>
                      <button role="menuitem" onClick={() => exportAs('png')}>Image (.png)</button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {running && (
              <div className="progress" aria-live="polite">
                {STEPS.map((s, i) => (
                  <div key={s} className={`step ${i < activeStep ? 'done' : i === activeStep ? 'on' : ''}`}><i />{s}</div>
                ))}
              </div>
            )}

            <div className="stage-body">
              <BpmnCanvas ref={canvas} xml={xml} highlight={focus} onDirty={onDirty} onError={onCanvasError} />
              {!xml && (
                <div className="empty">
                  {running ? <div className="trace-wrap"><TraceList trace={rec?.trace ?? []} /></div> : (
                    <>
                      <div className="empty-art" aria-hidden="true">
                        <svg viewBox="0 0 240 90" width="240"><circle cx="20" cy="45" r="10" fill="none" stroke="#a5b4fc" strokeWidth="3" /><path d="M30 45h30" stroke="#a5b4fc" strokeWidth="3" /><rect x="60" y="28" width="52" height="34" rx="6" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="3" /><path d="M112 45h22" stroke="#a5b4fc" strokeWidth="3" /><path d="M134 45l16-16 16 16-16 16z" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="3" /><path d="M166 45h30" stroke="#a5b4fc" strokeWidth="3" /><circle cx="206" cy="45" r="10" fill="#c7d2fe" stroke="#818cf8" strokeWidth="5" /></svg>
                      </div>
                      <h3>Your diagram appears here</h3>
                      <p>Pick a sample or paste your own process description, then press <b>Generate BPMN</b>. You can edit the result directly on the canvas.</p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {rec?.result && <Insights rec={rec} issues={issues} valid={valid} onFocus={setFocus} focused={focus} />}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
