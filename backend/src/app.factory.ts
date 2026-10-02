import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';

/** Builds the Nest application (middleware, prefix, security headers) without binding a port - shared by the server and the Vercel function. */
export async function createApp(logger?: false | Array<'error' | 'warn' | 'log'>): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, ...(logger !== undefined ? { logger } : {}) });
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Render / Vercel / nginx
  app.use(express.json({ limit: '3mb' }));
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  if (process.env.CORS_ORIGIN) app.enableCors({ origin: process.env.CORS_ORIGIN.split(','), credentials: false });
  app.setGlobalPrefix('api');
  return app;
}
