import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const log = new Logger('Bootstrap');

  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Render / Railway / nginx
  app.use(express.json({ limit: '3mb' }));
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  if (process.env.CORS_ORIGIN) app.enableCors({ origin: process.env.CORS_ORIGIN.split(','), credentials: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // Serve the built React app (single deployable unit).
  const dist = resolve(process.env.FRONTEND_DIST || join(__dirname, '../../frontend/dist'));
  if (existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(join(dist, 'index.html'));
    });
    log.log(`Serving frontend from ${dist}`);
  } else {
    log.warn(`Frontend build not found at ${dist} - API only.`);
  }

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  log.log(`FlowSmith AI listening on :${port}`);
}
bootstrap();
