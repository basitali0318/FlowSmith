import { useEffect, useState } from 'react';
import { api, tokenStore } from './api';
import type { Health } from './types';
import Login from './components/Login';
import Workspace from './components/Workspace';

export default function App() {
  const [user, setUser] = useState<string | null>(null);
  const [checking, setChecking] = useState(!!tokenStore.get());
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    if (!tokenStore.get()) return;
    api.me().then((r) => setUser(r.user.email)).catch(() => tokenStore.clear()).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="boot">Loading…</div>;
  if (!user) return <Login health={health} onAuthed={setUser} />;
  return <Workspace user={user} health={health} onLogout={() => { tokenStore.clear(); setUser(null); }} />;
}
