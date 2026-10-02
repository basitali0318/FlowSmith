import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal in-process job queue with bounded concurrency (stands in for BullMQ so the MVP
 * needs no Redis). The interface - enqueue(job) - is the seam where BullMQ plugs in.
 */
@Injectable()
export class QueueService {
  private readonly log = new Logger(QueueService.name);
  private readonly concurrency = Number(process.env.QUEUE_CONCURRENCY || 2);
  private active = 0;
  private waiting: Array<() => Promise<void>> = [];

  get depth() {
    return this.waiting.length + this.active;
  }

  enqueue(job: () => Promise<void>): void {
    this.waiting.push(job);
    this.pump();
  }

  private pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      job()
        .catch((e) => this.log.error(`Job crashed: ${e?.message ?? e}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
