import { Global, Module } from '@nestjs/common';
import { Store } from './store';

@Global()
@Module({ providers: [Store], exports: [Store] })
export class DbModule {}
