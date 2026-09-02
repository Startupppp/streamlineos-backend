import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";

export interface MediaTransformJob {
  readonly name: string;
  readonly orgId: string;
  run(): Promise<void>;
  /**
   * Runs when `run` throws or the deadline fires. This is where the half-written
   * object and the row that points at it are removed together — the runner never
   * decides what cleanup means, only that it happens.
   */
  compensate(error: Error): Promise<void>;
}

export interface RunnerStats {
  readonly active: number;
  readonly queued: number;
  readonly rejected: number;
  readonly failed: number;
}

const MAX_CONCURRENT = 2;
const MAX_QUEUED = 32;
const JOB_TIMEOUT_MS = 60_000;

/**
 * Runs media transforms off the request thread, under a hard ceiling.
 *
 * "Asynchronous" is not the property that matters here — an unbounded queue of
 * detached promises is a worse failure than doing the work inline, because the
 * inline version at least applies back-pressure through the request pool. Three
 * bounds make it a job runner rather than a leak:
 *
 *   CONCURRENCY  at most MAX_CONCURRENT transforms decode at once, so one large
 *                upload cannot take every core from every other request
 *   DEPTH        at most MAX_QUEUED wait, and each holds a buffer; submission is
 *                REFUSED past that, which is the back-pressure the caller must
 *                surface rather than silently absorb
 *   DEADLINE     every job is raced against JOB_TIMEOUT_MS and compensated on
 *                expiry, so a wedged transform releases its slot
 *
 * The runner is in-process on purpose. There is no queue broker in this repo,
 * and inventing a durable one for this would put a second, unwatched execution
 * substrate beside the outbox. The consequence is stated rather than hidden: a
 * process restart loses queued transforms, which is why `drain` runs on
 * shutdown and why every job's failure path deletes the object before the row
 * — a lost transform leaves an unreleased quarantine row that the storage sweep
 * already collects, never a reachable half-written object.
 */
@Injectable()
export class MediaTransformRunner implements OnModuleDestroy {
  private readonly logger = new Logger(MediaTransformRunner.name);
  private readonly queue: MediaTransformJob[] = [];
  private readonly running = new Set<Promise<void>>();
  private rejected = 0;
  private failed = 0;

  /**
   * Answers before the expensive part of a request begins, so a caller can fail
   * fast with back-pressure instead of doing a scan and a database write it is
   * about to throw away.
   */
  hasCapacity(): boolean {
    return this.queue.length < MAX_QUEUED;
  }

  /**
   * Returns false when the queue is full. A caller that ignores the answer has
   * removed the bound, so it is a value and not a throw: the two live callers
   * both have cleanup to perform before they can report the refusal.
   */
  submit(job: MediaTransformJob): boolean {
    if (this.queue.length >= MAX_QUEUED) {
      this.rejected++;
      this.logger.error("Media transform refused: queue is full", {
        name: job.name,
        queued: this.queue.length,
        active: this.running.size,
      });
      return false;
    }
    this.queue.push(job);
    this.pump();
    return true;
  }

  stats(): RunnerStats {
    return {
      active: this.running.size,
      queued: this.queue.length,
      rejected: this.rejected,
      failed: this.failed,
    };
  }

  /**
   * Settles when nothing is queued or running. Shutdown uses it so a transform
   * in flight is not abandoned mid-write; tests use it to make a detached job
   * observable without sleeping.
   */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.running.size > 0) {
      const inFlight = [...this.running];
      if (inFlight.length === 0) {
        this.pump();
        if (this.running.size === 0) return;
        continue;
      }
      await Promise.allSettled(inFlight);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  private pump(): void {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      const promise = this.execute(job).finally(() => {
        this.running.delete(promise);
        this.pump();
      });
      this.running.add(promise);
    }
  }

  private async execute(job: MediaTransformJob): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        job.run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`media transform "${job.name}" exceeded ${JOB_TIMEOUT_MS}ms`)),
            JOB_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.failed++;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error("Media transform failed", {
        name: job.name,
        orgId: job.orgId,
        reason: failure.message,
      });
      try {
        await job.compensate(failure);
      } catch (cleanupError) {
        /**
         * A failed compensation is the one state that leaves an orphan, so it
         * is reported at error level with both causes rather than folded into
         * the original failure.
         */
        this.logger.error("Media transform compensation failed", {
          name: job.name,
          orgId: job.orgId,
          reason:
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          afterFailure: failure.message,
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
