import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthedUser {
  id: string;
  email: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Sign in to continue.');
    try {
      const p = this.jwt.verify<{ sub: string; email: string }>(token);
      req.user = { id: p.sub, email: p.email } satisfies AuthedUser;
      return true;
    } catch {
      throw new UnauthorizedException('Your session expired. Please sign in again.');
    }
  }
}
