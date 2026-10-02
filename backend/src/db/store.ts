import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EngineChoice, PipelineResult, TraceStep } from '../pipeline/types';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface UserRec {
  id: string;
  email: string;
  passwordHash: string;
}

export interface ProcessRec {
  id: string;
  userId: string;
  title: string;
  sourceText: string;
  engineChoice: EngineChoice;
  status: JobStatus;
  result?: PipelineResult;
  trace: TraceStep[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persistence layer. Uses PostgreSQL when DATABASE_URL is set (schema is created on boot),
 * otherwise an in-memory map so the app also runs with zero infrastructure (demo / tests).
 */
@Injectable()
export class Store implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(Store.name);
  private pool?: Pool;
  private users = new Map<string, UserRec>();
  private procs = new Map<string, ProcessRec>();

  get mode(): 'postgres' | 'memory' {
    return this.pool ? 'postgres' : 'memory';
  }

  async onModuleInit() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      this.log.warn('DATABASE_URL not set - using in-memory storage (data is lost on restart).');
      return;
    }
    this.pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === 'true' || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
      max: 8,
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        email text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS processes (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        source_text text NOT NULL,
        engine_choice text NOT NULL,
        status text NOT NULL,
        result jsonb,
        trace jsonb NOT NULL DEFAULT '[]',
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS processes_user_idx ON processes(user_id, created_at DESC);
    `);
    this.log.log('Connected to PostgreSQL.');
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  /* ---------------------------------------------------------------- users */
  async findUserByEmail(email: string): Promise<UserRec | undefined> {
    const e = email.toLowerCase();
    if (!this.pool) return [...this.users.values()].find((u) => u.email === e);
    const r = await this.pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [e]);
    return r.rows[0] && { id: r.rows[0].id, email: r.rows[0].email, passwordHash: r.rows[0].password_hash };
  }

  async createUser(email: string, passwordHash: string): Promise<UserRec> {
    const u: UserRec = { id: randomUUID(), email: email.toLowerCase(), passwordHash };
    if (!this.pool) this.users.set(u.id, u);
    else await this.pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [u.id, u.email, u.passwordHash]);
    return u;
  }

  /* ------------------------------------------------------------ processes */
  async createProcess(p: Omit<ProcessRec, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProcessRec> {
    const now = new Date().toISOString();
    const rec: ProcessRec = { ...p, id: randomUUID(), createdAt: now, updatedAt: now };
    if (!this.pool) this.procs.set(rec.id, rec);
    else {
      await this.pool.query(
        `INSERT INTO processes (id, user_id, title, source_text, engine_choice, status, result, trace, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rec.id, rec.userId, rec.title, rec.sourceText, rec.engineChoice, rec.status, rec.result ?? null, JSON.stringify(rec.trace), rec.error ?? null],
      );
    }
    return rec;
  }

  async updateProcess(id: string, patch: Partial<Pick<ProcessRec, 'title' | 'status' | 'result' | 'trace' | 'error'>>): Promise<void> {
    if (!this.pool) {
      const cur = this.procs.get(id);
      if (cur) this.procs.set(id, { ...cur, ...patch, updatedAt: new Date().toISOString() });
      return;
    }
    const sets: string[] = ['updated_at = now()'];
    const vals: any[] = [];
    const add = (col: string, v: any) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.result !== undefined) add('result', JSON.stringify(patch.result));
    if (patch.trace !== undefined) add('trace', JSON.stringify(patch.trace));
    if (patch.error !== undefined) add('error', patch.error);
    vals.push(id);
    await this.pool.query(`UPDATE processes SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }

  async getProcess(id: string, userId: string): Promise<ProcessRec | undefined> {
    if (!this.pool) {
      const p = this.procs.get(id);
      return p && p.userId === userId ? p : undefined;
    }
    const r = await this.pool.query('SELECT * FROM processes WHERE id = $1 AND user_id = $2', [id, userId]);
    return r.rows[0] && this.fromRow(r.rows[0]);
  }

  async listProcesses(userId: string, limit = 30): Promise<Array<Pick<ProcessRec, 'id' | 'title' | 'status' | 'createdAt'> & { engine?: string }>> {
    if (!this.pool) {
      return [...this.procs.values()]
        .filter((p) => p.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((p) => ({ id: p.id, title: p.title, status: p.status, createdAt: p.createdAt, engine: p.result?.engine }));
    }
    const r = await this.pool.query(
      `SELECT id, title, status, created_at, result->>'engine' AS engine FROM processes WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((x) => ({ id: x.id, title: x.title, status: x.status, createdAt: new Date(x.created_at).toISOString(), engine: x.engine ?? undefined }));
  }

  async deleteProcess(id: string, userId: string): Promise<boolean> {
    if (!this.pool) {
      const p = this.procs.get(id);
      if (!p || p.userId !== userId) return false;
      return this.procs.delete(id);
    }
    const r = await this.pool.query('DELETE FROM processes WHERE id = $1 AND user_id = $2', [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  private fromRow(r: any): ProcessRec {
    return {
      id: r.id,
      userId: r.user_id,
      title: r.title,
      sourceText: r.source_text,
      engineChoice: r.engine_choice,
      status: r.status,
      result: r.result ?? undefined,
      trace: r.trace ?? [],
      error: r.error ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
}
