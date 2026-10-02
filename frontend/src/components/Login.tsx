import { FormEvent, useState } from 'react';
import { api, tokenStore } from '../api';
import type { Health } from '../types';
import Logo from './Logo';

export default function Login({ health, onAuthed }: { health: Health | null; onAuthed: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await (mode === 'login' ? api.login : api.register)(email, password);
      tokenStore.set(r.token);
      onAuthed(r.user.email);
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-hero">
        <Logo />
        <h1>Describe a process.<br />Get a validated BPMN diagram.</h1>
        <p>
          FlowSmith AI turns plain-language descriptions, SOP documents and meeting notes into BPMN 2.0, checks the result against the
          schema, repairs mistakes automatically, then flags bottlenecks, redundant steps and missing exception paths.
        </p>
        <ul className="hero-points">
          <li><b>Extract</b> actors, tasks, gateways and hand-offs</li>
          <li><b>Validate</b> with bpmn-moddle + automatic repair loop</li>
          <li><b>Improve</b> with bottleneck and exception-path analysis</li>
        </ul>
      </section>

      <form className="card login-card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></label>
        {err && <div className="alert error" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {health?.demo && mode === 'login' && (
          <button type="button" className="btn demo" onClick={() => { setEmail(health.demo!.email); setPassword(health.demo!.password); }}>
            <span>Use demo account</span>
            <code>{health.demo.email} / {health.demo.password}</code>
          </button>
        )}
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
          {mode === 'login' ? 'No account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
