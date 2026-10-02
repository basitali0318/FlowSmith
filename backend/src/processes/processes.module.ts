import { Module } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { ProcessesController } from './processes.controller';
import { ProcessesService } from './processes.service';
import { QueueService } from './queue.service';

@Module({
  controllers: [ProcessesController],
  providers: [ProcessesService, QueueService, DocumentsService],
})
export class ProcessesModule {}
