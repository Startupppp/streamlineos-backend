export type ShutdownPhase = "serving" | "draining" | "closed";

export interface ShutdownSnapshot {
  readonly phase: ShutdownPhase;
  readonly inFlight: number;
  readonly rejected: number;
}

export interface QuiescenceResult {
  readonly drained: boolean;
  readonly remaining: number;
}

/**
 * Process lifecycle, as a module singleton rather than a provider.
 *
 * Three consumers need the same answer and none of them share an injector: the
 * express gate installed in `main.ts` before Nest routing, the health controller
 * that must fail readiness first, and the background workers that must stop
 * claiming new leases. `poolTelemetry` and `sharedProviderBreaker` are the same
 * shape for the same reason.
 *
 * The two transitions are deliberately separate. `beginDrain` only makes
 * readiness report unready — the process keeps serving so the load balancer has
 * a window to take it out of rotation. `stopAccepting` is what actually refuses
 * new work, and only then is waiting for quiescence meaningful.
 */
class ShutdownState {
  private phase: ShutdownPhase = "serving";
  private inFlight = 0;
  private rejected = 0;
  private waiters = new Set<() => void>();

  get currentPhase(): ShutdownPhase {
    return this.phase;
  }

  isServing(): boolean {
    return this.phase === "serving";
  }

  /** True from the first shutdown signal onward. Workers use this to stop claiming. */
  isDraining(): boolean {
    return this.phase !== "serving";
  }

  acceptsNewWork(): boolean {
    return this.phase !== "closed";
  }

  beginDrain(): void {
    if (this.phase === "serving") this.phase = "draining";
  }

  stopAccepting(): void {
    this.phase = "closed";
    if (this.inFlight === 0) this.releaseWaiters();
  }

  /** Registers a unit of work. `false` means it must be refused. */
  enter(): boolean {
    if (this.phase === "closed") {
      this.rejected += 1;
      return false;
    }
    this.inFlight += 1;
    return true;
  }

  leave(): void {
    if (this.inFlight === 0) return;
    this.inFlight -= 1;
    if (this.inFlight === 0) this.releaseWaiters();
  }

  async awaitQuiescence(timeoutMs: number): Promise<QuiescenceResult> {
    if (this.inFlight === 0) return { drained: true, remaining: 0 };

    await new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, timeoutMs);
      this.waiters.add(waiter);
    });

    return { drained: this.inFlight === 0, remaining: this.inFlight };
  }

  snapshot(): ShutdownSnapshot {
    return { phase: this.phase, inFlight: this.inFlight, rejected: this.rejected };
  }

  /** Test seam only. Production never returns a drained process to service. */
  reset(): void {
    this.phase = "serving";
    this.inFlight = 0;
    this.rejected = 0;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const waiter of pending) waiter();
  }
}

export const shutdownState = new ShutdownState();
