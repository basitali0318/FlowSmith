import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { DocumentsService } from '../documents/documents.service';
import { ProcessesService } from './processes.service';
import { EngineChoice } from '../pipeline/types';

@Controller('processes')
@UseGuards(AuthGuard)
export class ProcessesController {
  constructor(private readonly processes: ProcessesService, private readonly docs: DocumentsService) {}

  @Post()
  @Throttle({ default: { limit: Number(process.env.GENERATE_RATE_LIMIT || 12), ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 4 * 1024 * 1024, files: 1 } }))
  async create(
    @Req() req: any,
    @Body() body: { description?: string; engine?: EngineChoice },
    @UploadedFile() file?: { originalname: string; buffer: Buffer; mimetype?: string },
  ) {
    const parts: string[] = [];
    if (file) parts.push(await this.docs.extractText(file));
    if (body?.description?.trim()) parts.push(body.description.trim());
    const rec = await this.processes.submit(req.user.id, parts.join('\n\n'), (body?.engine as EngineChoice) ?? 'auto');
    // On serverless the job already finished inside this request, so hand back the finished record directly.
    if (rec.status === 'done' || rec.status === 'failed') {
      const { userId, ...record } = rec;
      void userId;
      return { id: rec.id, status: rec.status, record };
    }
    return { id: rec.id, status: rec.status };
  }

  @Get()
  list(@Req() req: any) {
    return this.processes.list(req.user.id);
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.processes.get(req.user.id, id);
    const { userId, ...rest } = p;
    void userId;
    return rest;
  }

  @Put(':id/xml')
  saveXml(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() b: { xml: string }) {
    return this.processes.saveXml(req.user.id, id, b?.xml);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.processes.remove(req.user.id, id);
  }
}
