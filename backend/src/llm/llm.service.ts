import { Injectable, Logger } from '@nestjs/common';

type Provider = 'groq' | 'ollama' | 'openai' | 'none';

/**
 * Thin client for open-source model servers:
 *  - Groq    (LLM_PROVIDER=groq, needs GROQ_API_KEY) -> open-source Llama / Qwen models over an OpenAI-compatible API
 *  - Ollama  (LLM_PROVIDER=ollama, default)  -> POST /api/chat with structured-output `format`
 *  - vLLM / any OpenAI-compatible server (LLM_PROVIDER=openai) -> POST /v1/chat/completions
 * Set LLM_PROVIDER=none to force the deterministic rules engine.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger(LlmService.name);
  readonly provider: Provider = (process.env.LLM_PROVIDER as Provider) || (process.env.GROQ_API_KEY ? 'groq' : 'ollama');
  readonly baseUrl = (
    process.env.LLM_BASE_URL ||
    (this.provider === 'groq' ? 'https://api.groq.com/openai' : process.env.OLLAMA_URL || 'http://localhost:11434')
  ).replace(/\/$/, '');
  readonly model = process.env.LLM_MODEL || (this.provider === 'groq' ? 'llama-3.3-70b-versatile' : 'qwen2.5:7b-instruct');
  private readonly apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY || '';
  readonly timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 120000);
  private cache?: { at: number; ok: boolean };

  async isAvailable(): Promise<boolean> {
    if (this.provider === 'none' || (this.provider === 'groq' && !this.apiKey)) return false;
    if (this.cache && Date.now() - this.cache.at < 20000) return this.cache.ok;
    let ok = false;
    try {
      const url = this.provider === 'ollama' ? `${this.baseUrl}/api/tags` : `${this.baseUrl}/v1/models`;
      const res = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(3000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    this.cache = { at: Date.now(), ok };
    return ok;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  describe() {
    return { provider: this.provider, baseUrl: this.provider === 'none' ? null : this.baseUrl, model: this.model };
  }

  /** Ask the model for a JSON object. `schema` constrains decoding on Ollama; vLLM uses json_object mode. */
  async json(system: string, user: string, schema?: object): Promise<any> {
    const text = await this.chat(system, user, schema ?? 'json');
    return parseJsonLoose(text);
  }

  async text(system: string, user: string): Promise<string> {
    return this.chat(system, user);
  }

  private async chat(system: string, user: string, format?: object | 'json'): Promise<string> {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    if (this.provider === 'ollama') {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false, format, options: { temperature: 0.1, num_ctx: 8192 } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      return String(data?.message?.content ?? '');
    }
    if (this.provider === 'openai' || this.provider === 'groq') {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.1,
          ...(format ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`LLM server ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      return String(data?.choices?.[0]?.message?.content ?? '');
    }
    throw new Error('LLM provider disabled');
  }
}

export function parseJsonLoose(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error('Model did not return valid JSON');
  }
}
