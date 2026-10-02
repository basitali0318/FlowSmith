import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { runPipeline } from '../pipeline/graph';
import { validateBpmn } from '../pipeline/validator';
import { EngineChoice, TraceStep } from '../pipeline/types';
import { MAX_TEXT_CHARS } from '../documents/documents.service';
import { ProcessRec, Store } from '../db/store';
import { QueueService } from './queue.service';

@Injectable()
export class ProcessesService {
  private readonly log = new Logger(ProcessesService.name);

  constructor(private readonly store: Store, private readonly queue: QueueService, private readonly llm: LlmService) {}

  async submit(userId: string, text: string, engine: EngineChoice): Promise<ProcessRec> {
    text = (text ?? '').trim();
    if (text.length < 20) throw new BadRequestException('Describe the process in at least a couple of sentences, or upload a document.');
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    if (!['auto', 'llm', 'rules'].includes(engine)) engine = 'auto';

    const rec = await this.store.createProcess({
      userId,
      title: 'Generating…',
      sourceText: text,
      engineChoice: engine,
      status: 'queued',
      trace: [],
    });
    this.queue.enqueue(() => this.run(rec));
    return rec;
  }

  private async run(rec: ProcessRec): Promise<void> {
    const trace: TraceStep[] = [];
    // Persist progress so the UI can poll a live pipeline view.
    let writing = Promise.resolve();
    const onTrace = (t: TraceStep) => {
      if (t.status === 'running') trace.push(t);
      else {
        const i = trace.findLastIndex((x) => x.step === t.step && x.label === t.label && x.status === 'running');
        if (i >= 0) trace[i] = t;
        else trace.push(t);
      }
      const snapshot = [...trace];
      writing = writing.then(() => this.store.updateProcess(rec.id, { trace: snapshot })).catch(() => undefined);
    };
    try {
      await this.store.updateProcess(rec.id, { status: 'running' });
      const result = await runPipeline({ llm: this.llm, onTrace }, rec.sourceText, rec.engineChoice);
      await writing;
      await this.store.updateProcess(rec.id, { status: 'done', title: result.model.title, result, trace: [...trace] });
    } catch (e: any) {
      this.log.warn(`Pipeline failed for ${rec.id}: ${e?.message ?? e}`);
      await writing;
      await this.store.updateProcess(rec.id, { status: 'failed', title: 'Failed', error: String(e?.message ?? e), trace: [...trace] });
    }
  }

  async get(userId: string, id: string): Promise<ProcessRec> {
    const p = await this.store.getProcess(id, userId);
    if (!p) throw new NotFoundException('Process not found.');
    return p;
  }

  list(userId: string) {
    return this.store.listProcesses(userId);
  }

  async remove(userId: string, id: string) {
    if (!(await this.store.deleteProcess(id, userId))) throw new NotFoundException('Process not found.');
    return { ok: true };
  }

  /** Save a manually edited diagram from the bpmn-js modeler, re-validating it on the way. */
  async saveXml(userId: string, id: string, xml: string) {
    const p = await this.get(userId, id);
    if (!p.result) throw new BadRequestException('This process has no diagram yet.');
    if (typeof xml !== 'string' || xml.length < 50 || xml.length > 2_000_000) throw new BadRequestException('Invalid BPMN XML.');
    const v = await validateBpmn(xml);
    await this.store.updateProcess(id, { result: { ...p.result, xml, issues: v.issues, valid: v.valid } });
    return { valid: v.valid, issues: v.issues };
  }
}
