import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import * as express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();
  const log = new Logger('Bootstrap');

  // Serve the built React app (single deployable unit).
  const candidates = [process.env.FRONTEND_DIST, join(__dirname, '../public'), join(__dirname, '../../frontend/dist')]
    .filter((p): p is string => !!p)
    .map((p) => resolve(p));
  const dist = candidates.find((p) => existsSync(join(p, 'index.html'))) ?? candidates[0];
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
