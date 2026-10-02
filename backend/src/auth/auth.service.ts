import { BadRequestException, ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from '../db/store';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@flowsmith.ai';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly store: Store, private readonly jwt: JwtService) {}

  /** Seeds the public demo account used for the hackathon / review link. */
  async onModuleInit() {
    if (process.env.SEED_DEMO_USER === 'false') return;
    if (!(await this.store.findUserByEmail(DEMO_EMAIL))) {
      await this.store.createUser(DEMO_EMAIL, await hashPassword(DEMO_PASSWORD));
    }
  }

  private token(u: { id: string; email: string }) {
    return { token: this.jwt.sign({ sub: u.id, email: u.email }), user: { id: u.id, email: u.email } };
  }

  async login(email: string, password: string) {
    const u = typeof email === 'string' && typeof password === 'string' ? await this.store.findUserByEmail(email.trim()) : undefined;
    // Always run a hash comparison to keep timing similar for unknown users.
    const ok = await verifyPassword(password ?? '', u?.passwordHash ?? 'aa:bb');
    if (!u || !ok) throw new UnauthorizedException('Invalid email or password.');
    return this.token(u);
  }

  async register(email: string, password: string) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new BadRequestException('Enter a valid email address.');
    if (String(password ?? '').length < 8) throw new BadRequestException('Password must be at least 8 characters.');
    if (await this.store.findUserByEmail(e)) throw new ConflictException('An account with this email already exists.');
    return this.token(await this.store.createUser(e, await hashPassword(password)));
  }
}
