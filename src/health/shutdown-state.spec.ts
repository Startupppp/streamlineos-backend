import { shutdownState } from "./shutdown-state";

describe("shutdownState — drain before exit", () => {
  afterEach(() => {
    shutdownState.reset();
  });

  it("keeps accepting work through the settling window so the load balancer can react", () => {
    shutdownState.beginDrain();

    expect(shutdownState.currentPhase).toBe("draining");
    expect(shutdownState.acceptsNewWork()).toBe(true);
    expect(shutdownState.enter()).toBe(true);
  });

  it("reports draining from the first signal, so workers stop claiming immediately", () => {
    expect(shutdownState.isDraining()).toBe(false);

    shutdownState.beginDrain();

    expect(shutdownState.isDraining()).toBe(true);
  });

  it("refuses new work once accepting has stopped, and counts the refusals", () => {
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    expect(shutdownState.enter()).toBe(false);
    expect(shutdownState.enter()).toBe(false);
    expect(shutdownState.snapshot()).toEqual({ phase: "closed", inFlight: 0, rejected: 2 });
  });

  it("resolves quiescence immediately when nothing is in flight", async () => {
    shutdownState.stopAccepting();

    await expect(shutdownState.awaitQuiescence(10_000)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });
  });

  it("waits for in-flight work to finish before reporting drained", async () => {
    expect(shutdownState.enter()).toBe(true);
    expect(shutdownState.enter()).toBe(true);
    shutdownState.stopAccepting();

    const quiescence = shutdownState.awaitQuiescence(10_000);
    let settled = false;
    void quiescence.then(() => {
      settled = true;
    });

    await Promise.resolve();
    shutdownState.leave();
    await Promise.resolve();
    expect(settled).toBe(false);

    shutdownState.leave();

    await expect(quiescence).resolves.toEqual({ drained: true, remaining: 0 });
  });

  it("gives up on the deadline and reports what is still running rather than hanging", async () => {
    shutdownState.enter();
    shutdownState.stopAccepting();

    await expect(shutdownState.awaitQuiescence(5)).resolves.toEqual({
      drained: false,
      remaining: 1,
    });
  });

  it("never lets the in-flight count go negative on a double release", () => {
    shutdownState.enter();
    shutdownState.leave();
    shutdownState.leave();

    expect(shutdownState.snapshot().inFlight).toBe(0);
  });
});
