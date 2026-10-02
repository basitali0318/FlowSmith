import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app.factory';

let ready: Promise<(req: IncomingMessage, res: ServerResponse) => void> | undefined;

/** Vercel Function entry: boots Nest once per warm instance and forwards every request to Express. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= (async () => {
    const app = await createApp(['error', 'warn']);
    await app.init();
    return app.getHttpAdapter().getInstance();
  })();
  (await ready)(req, res);
}
