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
  /** Model asked for via LLM_MODEL (or the provider default). The model actually used may differ - see `model`. */
  readonly configuredModel = process.env.LLM_MODEL || (this.provider === 'groq' ? 'llama-3.3-70b-versatile' : 'qwen2.5:7b-instruct');
  private readonly modelPinned = !!process.env.LLM_MODEL;
  private resolvedModel?: string;
  private availableModels: string[] = [];
  private readonly apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY || '';
  readonly timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 120000);
  private cache?: { at: number; ok: boolean };

  /** The model requests are sent to. Hosted providers retire models, so it is resolved against the server's live model list. */
  get model(): string {
    return this.resolvedModel ?? this.configuredModel;
  }

  async isAvailable(): Promise<boolean> {
    if (this.provider === 'none' || (this.provider === 'groq' && !this.apiKey)) return false;
    if (this.cache && Date.now() - this.cache.at < 20000) return this.cache.ok;
    let ok = false;
    try {
      const url = this.provider === 'ollama' ? `${this.baseUrl}/api/tags` : `${this.baseUrl}/v1/models`;
      const res = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(3000) });
      ok = res.ok;
      if (ok && this.provider !== 'ollama') this.resolveModel(await res.json().catch(() => undefined));
    } catch {
      ok = false;
    }
    this.cache = { at: Date.now(), ok };
    return ok;
  }

  /** Keep an explicitly requested/available model; otherwise choose the best open-weight chat model the key can use. */
  private resolveModel(body: any): void {
    const ids: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m?.id)).filter(Boolean) : [];
    this.availableModels = ids;
    if (!ids.length || ids.includes(this.configuredModel)) {
      this.resolvedModel = undefined;
      return;
    }
    if (this.modelPinned) {
      this.log.warn(`LLM_MODEL "${this.configuredModel}" is not offered by the server; requests will probably fail. Available: ${ids.join(', ')}`);
      return;
    }
    const chat = ids.filter((id) => !/whisper|tts|guard|embed|orpheus|playai|vision|safeguard|compound|moderation/i.test(id));
    const prefer = [/^llama-3\.3-70b/, /^llama-3\.1-70b/, /llama-4-(maverick|scout)/, /qwen.*(72b|32b)/, /gpt-oss-120b/, /gpt-oss-20b/, /^llama-3\.1-8b/, /llama/, /qwen/, /gpt-oss/];
    const pick = prefer.map((re) => chat.find((id) => re.test(id))).find(Boolean) ?? chat[0];
    if (pick) {
      this.log.warn(`Model "${this.configuredModel}" is not available; using "${pick}" instead.`);
      this.resolvedModel = pick;
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  describe() {
    return {
      provider: this.provider,
      baseUrl: this.provider === 'none' ? null : this.baseUrl,
      model: this.model,
      ...(this.model !== this.configuredModel ? { configuredModel: this.configuredModel } : {}),
      ...(this.availableModels.length ? { availableModels: this.availableModels } : {}),
    };
  }

  /** Ask the model for a JSON object. `schema` constrains decoding on Ollama; vLLM uses json_object mode. */
  async json(system: string, user: string, schema?: object): Promise<any> {
    const text = await this.chat(system, user, schema ?? 'json');
    return parseJsonLoose(text);
  }

  async text(system: string, user: string): Promise<string> {
    return stripThinking(await this.chat(system, user));
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

/** Reasoning models (e.g. Qwen3) prepend <think>...</think>; it must not reach the JSON parser or the UI. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
}

export function parseJsonLoose(text: string): any {
  const t = stripThinking(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error('Model did not return valid JSON');
  }
}
