import type { Health, ProcessListItem, ProcessRec, Sample } from './types';

const KEY = 'flowsmith.token';
export const tokenStore = {
  get(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t: string) { try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ } },
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const t = tokenStore.get();
  if (t) headers.set('authorization', `Bearer ${t}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
    throw new ApiError(res.status === 429 ? 'Too many requests - please wait a minute and try again.' : msg || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  health: () => request<Health>('/health'),
  samples: () => request<Sample[]>('/samples'),
  login: (email: string, password: string) => request<{ token: string; user: { email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) => request<{ token: string; user: { email: string } }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<{ user: { email: string } }>('/auth/me'),
  list: () => request<ProcessListItem[]>('/processes'),
  get: (id: string) => request<ProcessRec>(`/processes/${id}`),
  remove: (id: string) => request<{ ok: true }>(`/processes/${id}`, { method: 'DELETE' }),
  create: (description: string, engine: string, file?: File | null) => {
    const f = new FormData();
    if (description) f.set('description', description);
    f.set('engine', engine);
    if (file) f.set('file', file);
    return request<{ id: string; status: string }>('/processes', { method: 'POST', body: f });
  },
  saveXml: (id: string, xml: string) => request<{ valid: boolean; issues: import('./types').Issue[] }>(`/processes/${id}/xml`, { method: 'PUT', body: JSON.stringify({ xml }) }),
};
