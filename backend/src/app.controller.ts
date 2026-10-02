import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Store } from './db/store';
import { LlmService } from './llm/llm.service';
import { DEMO_EMAIL, DEMO_PASSWORD } from './auth/auth.service';
import { SAMPLES } from './samples';

@Controller()
export class AppController {
  constructor(private readonly llm: LlmService, private readonly store: Store) {}

  @Get('health')
  @SkipThrottle()
  async health() {
    const llmUp = await this.llm.isAvailable();
    return {
      status: 'ok',
      storage: this.store.mode,
      engine: llmUp ? { mode: 'llm', ...this.llm.describe() } : { mode: 'rules', note: 'No model server reachable; using the deterministic rules engine.', configured: this.llm.describe() },
      demo: process.env.SHOW_DEMO_CREDENTIALS === 'false' ? undefined : { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    };
  }

  @Get('samples')
  samples() {
    return SAMPLES;
  }
}
