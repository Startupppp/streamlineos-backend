import { ReadinessService } from "./readiness.service";
import type { ReadinessConfig } from "./readiness.config";
import type { DependencyCheck, DependencyOutcome } from "./readiness.types";

const BASE_CONFIG: ReadinessConfig = {
  cacheTtlMs: 5_000,
  checkTimeoutMs: 50,
  queueStallSeconds: 900,
  queueHeartbeatJobs: [],
  requiredProviders: [],
  settlingDelayMs: 0,
  drainTimeoutMs: 0,
};

function config(overrides: Partial<ReadinessConfig> = {}): ReadinessConfig {
  return { ...BASE_CONFIG, ...overrides };
}

function check(
  name: string,
  required: boolean,
  run: () => Promise<DependencyOutcome>,
): DependencyCheck {
  return { name, required, run };
}

function frozenClock(startAt = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = startAt;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("ReadinessService — the probe must not amplify the outage it reports", () => {
  it("checks each dependency once across 50 sequential probes inside the cache window", async () => {
    const probe = jest.fn<Promise<DependencyOutcome>, []>().mockResolvedValue({ state: "up" });
    const clock = frozenClock();
    const service = new ReadinessService(
      [check("database", true, probe)],
      config(),
      clock.now,
    );

    for (let i = 0; i < 50; i++) await service.read();

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("checks each dependency once across 50 concurrent probes — single flight, not fifty fanouts", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = jest.fn<Promise<DependencyOutcome>, []>().mockImplementation(async () => {
      await gate;
      return { state: "up" };
    });
    const clock = frozenClock();
    const service = new ReadinessService([check("database", true, probe)], config(), clock.now);

    const probes = Array.from({ length: 50 }, () => service.read());
    release?.();
    const snapshots = await Promise.all(probes);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(snapshots.every((snapshot) => snapshot.status === "ready")).toBe(true);
  });

  it("marks a served snapshot as cached and reports its age", async () => {
    const probe = jest.fn<Promise<DependencyOutcome>, []>().mockResolvedValue({ state: "up" });
    const clock = frozenClock();
    const service = new ReadinessService([check("database", true, probe)], config(), clock.now);

    const fresh = await service.read();
    clock.advance(1_200);
    const cached = await service.read();

    expect(fresh.cached).toBe(false);
    expect(fresh.ageMs).toBe(0);
    expect(cached.cached).toBe(true);
    expect(cached.ageMs).toBe(1_200);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-checks once the cache window has elapsed, and not before", async () => {
    const probe = jest.fn<Promise<DependencyOutcome>, []>().mockResolvedValue({ state: "up" });
    const clock = frozenClock();
    const service = new ReadinessService([check("database", true, probe)], config(), clock.now);

    await service.read();
    clock.advance(4_999);
    await service.read();
    expect(probe).toHaveBeenCalledTimes(1);

    clock.advance(2);
    await service.read();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung dependency instead of holding the probe open", async () => {
    const probe = jest
      .fn<Promise<DependencyOutcome>, []>()
      .mockImplementation(() => new Promise<DependencyOutcome>(() => undefined));
    const service = new ReadinessService(
      [check("database", true, probe)],
      config({ checkTimeoutMs: 20 }),
    );

    const snapshot = await service.read();

    expect(snapshot.status).toBe("unready");
    expect(snapshot.dependencies[0]?.state).toBe("down");
    expect(snapshot.dependencies[0]?.detail).toContain("20ms readiness budget");
  });
});

describe("ReadinessService — dependency-aware status", () => {
  it("reports unready when the database is dead", async () => {
    const service = new ReadinessService(
      [
        check("database", true, () => Promise.reject(new Error("connection refused"))),
        check("cache", false, () => Promise.resolve({ state: "up" })),
      ],
      config(),
    );

    const snapshot = await service.read();

    expect(snapshot.status).toBe("unready");
    const database = snapshot.dependencies.find((entry) => entry.name === "database");
    expect(database?.state).toBe("down");
    expect(database?.detail).toBe("connection refused");
  });

  it("reports degraded — not unready — when only an optional dependency fails", async () => {
    const service = new ReadinessService(
      [
        check("database", true, () => Promise.resolve({ state: "up" })),
        check("cache", false, () =>
          Promise.resolve({ state: "degraded", detail: "redis timeout" }),
        ),
      ],
      config(),
    );

    const snapshot = await service.read();

    expect(snapshot.status).toBe("degraded");
    expect(snapshot.dependencies.find((entry) => entry.name === "cache")?.state).toBe("degraded");
  });

  it("reports unready when a required provider's circuit is open", async () => {
    const service = new ReadinessService(
      [
        check("database", true, () => Promise.resolve({ state: "up" })),
        check("providers", true, () =>
          Promise.resolve({ state: "down", detail: "circuit open for required provider(s): pay" }),
        ),
      ],
      config(),
    );

    expect((await service.read()).status).toBe("unready");
  });

  it("reports ready when every dependency is up or deliberately skipped", async () => {
    const service = new ReadinessService(
      [
        check("database", true, () => Promise.resolve({ state: "up" })),
        check("cache", false, () =>
          Promise.resolve({ state: "skipped", detail: "Redis is not configured" }),
        ),
      ],
      config(),
    );

    const snapshot = await service.read();

    expect(snapshot.status).toBe("ready");
    expect(snapshot.dependencies.map((entry) => entry.name)).toEqual(["database", "cache"]);
  });

  it("does not serve a cached snapshot after invalidate", async () => {
    const probe = jest.fn<Promise<DependencyOutcome>, []>().mockResolvedValue({ state: "up" });
    const clock = frozenClock();
    const service = new ReadinessService([check("database", true, probe)], config(), clock.now);

    await service.read();
    service.invalidate();
    await service.read();

    expect(probe).toHaveBeenCalledTimes(2);
  });
});
