import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

const secret = process.env.JWT_SECRET || randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET not set - generated an ephemeral secret; sessions reset on restart.');

@Global()
@Module({
  imports: [JwtModule.register({ secret, signOptions: { expiresIn: '12h' } })],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthGuard, JwtModule],
})
export class AuthModule {}
