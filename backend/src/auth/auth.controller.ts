import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() b: { email: string; password: string }) {
    return this.auth.login(b?.email, b?.password);
  }

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() b: { email: string; password: string }) {
    return this.auth.register(b?.email, b?.password);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: any) {
    return { user: req.user };
  }
}
