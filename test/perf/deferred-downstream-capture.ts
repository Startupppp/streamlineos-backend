import { observeAfterCommitWork } from "src/common/observability/after-commit-work";

export class DeferredDownstreamCapture {
  private readonly pending = new Set<Promise<void>>();
  private stopObserving: (() => void) | undefined;
  private calls = 0;
  private failures = 0;
  private readonly targets = new Map<string, number>();

  install(): void {
    if (this.stopObserving) return;
    this.stopObserving = observeAfterCommitWork((completion) => {
      const tracked = completion.then(
        () => undefined,
        () => { this.failures += 1; },
      );
      this.pending.add(tracked);
      void tracked.then(() => this.pending.delete(tracked));
    });
  }

  restore(): void {
    this.stopObserving?.();
    this.stopObserving = undefined;
  }

  record(origin: string): void {
    this.calls += 1;
    this.targets.set(origin, (this.targets.get(origin) ?? 0) + 1);
  }

  reset(): void {
    if (this.pending.size > 0) throw new Error("Cannot reset capture while after-commit work is pending");
    this.calls = 0;
    this.failures = 0;
    this.targets.clear();
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  snapshot(): { calls: number; failures: number; targets: Record<string, number> } {
    return { calls: this.calls, failures: this.failures, targets: Object.fromEntries(this.targets) };
  }
}
