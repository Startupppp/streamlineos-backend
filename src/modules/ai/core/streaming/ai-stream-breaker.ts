import { ServiceUnavailableException } from "@nestjs/common";

export interface AiStreamBreakerRedis {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: number, opts: { ex: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface AiStreamBreakerOptions {
  key: string;
  unavailableMessage: string;
  redis?: AiStreamBreakerRedis | null;
  failureThreshold?: number;
  openDurationMs?: number;
  now?: () => number;
}

export const AI_STREAM_BREAKER_FAILURE_THRESHOLD = 5;
export const AI_STREAM_BREAKER_OPEN_DURATION_MS = 30_000;

/**
 * Re-arming matters more than opening. Counting `failures === threshold` opens
 * once and then never again: past the threshold the equality stops matching, the
 * first open window expires, and the breaker is inert for the rest of the process
 * because only a success resets the counter — which a dead provider never gives.
 */
export class AiStreamBreaker {
  private failures = 0;
  private openedAt = 0;

  private readonly threshold: number;
  private readonly openMs: number;
  private readonly openedAtKey: string;
  private readonly failuresKey: string;
  private readonly redis: AiStreamBreakerRedis | null;
  private readonly now: () => number;
  private readonly unavailableMessage: string;

  constructor(options: AiStreamBreakerOptions) {
    this.threshold = options.failureThreshold ?? AI_STREAM_BREAKER_FAILURE_THRESHOLD;
    this.openMs = options.openDurationMs ?? AI_STREAM_BREAKER_OPEN_DURATION_MS;
    this.openedAtKey = `ai:cb:${options.key}:opened_at`;
    this.failuresKey = `ai:cb:${options.key}:failures`;
    this.redis = options.redis ?? null;
    this.now = options.now ?? Date.now;
    this.unavailableMessage = options.unavailableMessage;
  }

  async isOpen(): Promise<boolean> {
    if (this.redis) {
      try {
        const openedAt = await this.redis.get<number>(this.openedAtKey);
        if (openedAt !== null && openedAt !== undefined) return true;
      } catch {
        return this.isLocallyOpen();
      }
    }
    return this.isLocallyOpen();
  }

  async assertClosed(): Promise<void> {
    if (await this.isOpen())
      throw new ServiceUnavailableException(this.unavailableMessage);
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
    const r = this.redis;
    if (!r) return;
    void Promise.all([r.del(this.failuresKey), r.del(this.openedAtKey)]).catch(
      () => undefined,
    );
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.failures = this.threshold;
      this.openedAt = this.now();
    }

    const r = this.redis;
    if (!r) return;
    const openSeconds = Math.max(1, Math.ceil(this.openMs / 1000));
    void (async () => {
      try {
        const count = await r.incr(this.failuresKey);
        await r.expire(this.failuresKey, openSeconds * 2);
        if (count >= this.threshold)
          await r.set(this.openedAtKey, this.now(), { ex: openSeconds });
      } catch {
        return;
      }
    })();
  }

  private isLocallyOpen(): boolean {
    return (
      this.failures >= this.threshold && this.now() - this.openedAt < this.openMs
    );
  }
}
