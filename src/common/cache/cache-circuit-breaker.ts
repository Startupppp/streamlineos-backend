import type { TimedRedisOp } from "./cache-redis-op.types";

const FAILURE_THRESHOLD = 5;
const PROBE_INTERVAL_MS = 5_000;

export class CacheCircuitBreaker {
  private open = false;
  private openAt = 0;
  private probeInFlight = false;
  private consecutiveFailures = 0;

  constructor(private readonly timed: TimedRedisOp) {}

  get isOpen(): boolean {
    return this.open;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.open) {
      const canProbe =
        !this.probeInFlight &&
        Date.now() - this.openAt >= PROBE_INTERVAL_MS;
      if (!canProbe) throw new Error("cache:breaker:open");
      this.probeInFlight = true;
    }
    try {
      const result = await this.timed(operation);
      this.consecutiveFailures = 0;
      this.open = false;
      this.probeInFlight = false;
      return result;
    } catch (err) {
      this.probeInFlight = false;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FAILURE_THRESHOLD || this.open) {
        this.open = true;
        this.openAt = Date.now();
      }
      throw err;
    }
  }
}
