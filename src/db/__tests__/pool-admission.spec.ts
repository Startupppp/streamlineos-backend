import { HttpStatus } from "@nestjs/common";
import {
  PoolSaturatedError,
  configurePoolAdmission,
  poolAdmission,
  resolvePoolAdmissionConfig,
} from "../pool-admission";
import { poolTelemetry, withPoolBorrow } from "../pool-telemetry";
import { resolvePoolConfig } from "../pool.config";

/**
 * Box 7, connection pool. postgres-js has no acquire or queue timeout and its
 * pool handler pushes onto an unbounded FIFO when every connection is checked
 * out, so a slow database produced an application that never answered rather
 * than one that refused. These pin what backpressure means here: a bounded
 * queue, a deadline on the wait, and — the load-bearing half — a shed caller
 * that never reaches the driver, so it can never execute a statement it was
 * already told it would not run.
 */
describe("pool admission", () => {
  afterEach(() => {
    poolAdmission.reset();
    poolTelemetry.reset();
  });

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("is inert until configured, so a unit test with no pool is never gated", async () => {
    expect(poolAdmission.snapshot().configured).toBe(false);

    const releases = await Promise.all(
      Array.from({ length: 50 }, () => poolAdmission.acquire("primary")),
    );

    expect(releases).toHaveLength(50);
    for (const release of releases) release();
  });

  it("admits up to the pool's own capacity and queues the rest", async () => {
    configurePoolAdmission({ maxConcurrent: 2, maxQueueDepth: 4, acquireTimeoutMs: 1_000 });

    const held = [await poolAdmission.acquire("p"), await poolAdmission.acquire("p")];
    let thirdAdmitted = false;
    const third = poolAdmission.acquire("p").then((release) => {
      thirdAdmitted = true;
      return release;
    });

    await settle();
    expect(thirdAdmitted).toBe(false);
    expect(poolAdmission.snapshot().queued).toBe(1);

    held[0]?.();
    const release = await third;
    expect(thirdAdmitted).toBe(true);

    release();
    held[1]?.();
    expect(poolAdmission.snapshot().active).toBe(0);
  });

  it("sheds with 503 once the wait queue is full", async () => {
    configurePoolAdmission({ maxConcurrent: 1, maxQueueDepth: 1, acquireTimeoutMs: 1_000 });

    const held = await poolAdmission.acquire("p");
    const queued = poolAdmission.acquire("p");
    await settle();

    await expect(poolAdmission.acquire("p")).rejects.toBeInstanceOf(PoolSaturatedError);

    let status = 0;
    let reason = "";
    try {
      await poolAdmission.acquire("p");
    } catch (error: unknown) {
      if (error instanceof PoolSaturatedError) {
        status = error.getStatus();
        reason = error.reason;
      }
    }
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(reason).toBe("queue-full");
    expect(poolAdmission.snapshot().shedQueueFull).toBe(2);

    held();
    (await queued)();
  });

  it("sheds a waiter that outlives the acquire deadline", async () => {
    configurePoolAdmission({ maxConcurrent: 1, maxQueueDepth: 8, acquireTimeoutMs: 20 });

    const held = await poolAdmission.acquire("p");

    let reason = "";
    try {
      await poolAdmission.acquire("p");
    } catch (error: unknown) {
      if (error instanceof PoolSaturatedError) reason = error.reason;
    }

    expect(reason).toBe("acquire-timeout");
    expect(poolAdmission.snapshot().shedAcquireTimeout).toBe(1);
    expect(poolAdmission.snapshot().queued).toBe(0);

    held();
  });

  it("counts capacity per lane, because each region opens its own pool", async () => {
    configurePoolAdmission({ maxConcurrent: 1, maxQueueDepth: 0, acquireTimeoutMs: 20 });

    const primary = await poolAdmission.acquire("primary");
    const secondary = await poolAdmission.acquire("eu-west");

    expect(poolAdmission.snapshot().active).toBe(2);
    await expect(poolAdmission.acquire("primary")).rejects.toBeInstanceOf(PoolSaturatedError);

    primary();
    secondary();
  });

  describe("through withPoolBorrow", () => {
    it("never runs the transaction body for a shed caller", async () => {
      configurePoolAdmission({ maxConcurrent: 1, maxQueueDepth: 0, acquireTimeoutMs: 20 });

      let bodyRuns = 0;
      let releaseHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });

      const holder = withPoolBorrow(async (borrow) => {
        bodyRuns += 1;
        borrow.acquired();
        await held;
      });
      await settle();

      await expect(
        withPoolBorrow(async (borrow) => {
          bodyRuns += 1;
          borrow.acquired();
        }),
      ).rejects.toBeInstanceOf(PoolSaturatedError);

      expect(bodyRuns).toBe(1);
      expect(poolTelemetry.snapshot().failedAcquires).toBe(1);
      expect(poolTelemetry.snapshot().borrows).toBe(1);

      releaseHeld?.();
      await holder;
    });

    it("releases the slot when the transaction body throws", async () => {
      configurePoolAdmission({ maxConcurrent: 1, maxQueueDepth: 0, acquireTimeoutMs: 20 });

      await expect(
        withPoolBorrow(async (borrow) => {
          borrow.acquired();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(poolAdmission.snapshot().active).toBe(0);
      const release = await poolAdmission.acquire("primary");
      release();
    });
  });

  describe("defaults", () => {
    it("sizes the gate from the pool it fronts", () => {
      const resolved = resolvePoolAdmissionConfig({ max: 20 });
      expect(resolved.maxConcurrent).toBe(20);
      expect(resolved.maxQueueDepth).toBe(80);
      expect(resolved.acquireTimeoutMs).toBe(5_000);
    });

    it("is on by default and stays under the statement-timeout budget", () => {
      const config = resolvePoolConfig({
        DATABASE_URL: "postgres://u:p@localhost:5432/scratch_pool_admission",
      });
      expect(config.admission.enabled).toBe(true);
      expect(config.admission.queueDepth).toBe(config.max * 4);
      expect(config.admission.acquireTimeoutMs).toBeLessThan(
        config.guards.statementTimeoutMs,
      );
    });

    it("can be turned off only by an explicit deployment setting", () => {
      const config = resolvePoolConfig({
        DATABASE_URL: "postgres://u:p@localhost:5432/scratch_pool_admission",
        DB_POOL_ADMISSION_ENABLED: "false",
      });
      expect(config.admission.enabled).toBe(false);
    });
  });
});
