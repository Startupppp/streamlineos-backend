import { CronRetentionSchedulerService } from "../cron-retention-scheduler.service";
import { CronLeaseService, HEARTBEAT_KEY_PREFIX } from "../cron-lease.service";
import { RETENTION_JOBS } from "../retention-schedule";

// ─── The sweeps were correct and nothing ran them ────────────────────────────
//
// MECHANISM: every retention drain was reachable only as POST /cron/<job> behind
// CRON_SECRET, and no scheduler in either repository ever sent that request — the
// README's schedule table named five jobs, none of them a retention sweep. The
// fixtures below drive EVERY declared job, not a sample: a fixture covering one job
// cannot catch a scheduler that runs the first and forgets the rest, which is the
// same shape as a drain that deletes the first page and reports success.

interface Stub {
  fn: jest.Mock;
}

function stub(): Stub & Record<string, jest.Mock> {
  const fn = jest.fn().mockResolvedValue({ ok: true });
  return {
    fn,
    sweep: fn,
    purgeExpiredTrash: fn,
    purgeExpiredConversations: fn,
    pruneStaleChunks: fn,
    pruneWebhookDeliveries: fn,
    sweepAiReservations: fn,
    processMonthlyPlanGrants: fn,
    processTrialExpiry: fn,
  };
}

function buildScheduler(
  redis: never | null,
  lease: CronLeaseService,
  s: ReturnType<typeof stub>[],
): CronRetentionSchedulerService {
  return new CronRetentionSchedulerService(
    redis,
    lease,
    s[0] as never,
    s[1] as never,
    s[2] as never,
    s[3] as never,
    s[4] as never,
    s[5] as never,
    s[6] as never,
    s[7] as never,
    s[8] as never,
    s[9] as never,
    s[10] as never,
    s[11] as never,
    s[12] as never,
    s[13] as never,
    s[14] as never,
    s[15] as never,
  );
}

interface Harness {
  service: CronRetentionSchedulerService;
  lease: { withLease: jest.Mock };
  redis: { get: jest.Mock };
  services: ReturnType<typeof stub>[];
}

function makeHarness(options: { heartbeats?: Record<string, string> } = {}): Harness {
  const heartbeats = options.heartbeats ?? {};
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(heartbeats[key] ?? null)),
  };
  const lease = {
    withLease: jest.fn(
      async (_jobKey: string, _seconds: number, fn: () => Promise<unknown>) => ({
        ran: true as const,
        result: await fn(),
      }),
    ),
  };
  const services = Array.from({ length: RETENTION_JOBS.length }, () => stub());
  const service = buildScheduler(redis as never, lease as unknown as CronLeaseService, services);
  return { service, lease, redis, services };
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CronRetentionSchedulerService — every declared sweep actually runs", () => {
  it("runs every declared retention job in one tick when nothing has a heartbeat", async () => {
    const { service, lease } = makeHarness();

    const outcome = await service.tick();

    /*
     * An anti-vacuity floor, not a budget: it exists so this test cannot pass over an
     * empty declaration list. It moves UP as jobs are added and must never move down —
     * 16 to 18 when kb-telemetry-retention-sweep was written and kb-trash-purge stopped
     * being deliberately unscheduled (ticket 16, PRD-C134).
     */
    expect(RETENTION_JOBS.length).toBe(18);
    expect(outcome.considered).toBe(RETENTION_JOBS.length);
    expect(outcome.ran).toHaveLength(RETENTION_JOBS.length);
    expect(outcome.failed).toEqual([]);
    expect(lease.withLease).toHaveBeenCalledTimes(RETENTION_JOBS.length);
    for (const job of RETENTION_JOBS) expect(outcome.ran).toContain(job.jobKey);
  });

  it("takes each job's declared lease key and window", async () => {
    const { service, lease } = makeHarness();

    await service.tick();

    const leased = lease.withLease.mock.calls.map((c) => [c[0], c[1]]);
    for (const job of RETENTION_JOBS)
      expect(leased).toContainEqual([job.jobKey, job.leaseSeconds]);
  });

  it("has a runner registered for every declared job — a declared job with no runner is loud", async () => {
    const { service, lease } = makeHarness();

    const outcome = await service.tick();

    expect(outcome.failed).toEqual([]);
    const invoked = new Set(lease.withLease.mock.calls.map((c: unknown[]) => c[0]));
    expect(invoked.size).toBe(RETENTION_JOBS.length);
  });
});

describe("CronRetentionSchedulerService — the heartbeat decides, so an external scheduler composes", () => {
  it("stands down for a job whose heartbeat is fresher than its interval", async () => {
    const fresh: Record<string, string> = {};
    for (const job of RETENTION_JOBS)
      fresh[`${HEARTBEAT_KEY_PREFIX}${job.jobKey}`] = isoAgo(60_000);
    const { service, lease } = makeHarness({ heartbeats: fresh });

    const outcome = await service.tick();

    expect(outcome.ran).toEqual([]);
    expect(outcome.skipped).toHaveLength(RETENTION_JOBS.length);
    expect(lease.withLease).not.toHaveBeenCalled();
  });

  it("runs a job whose heartbeat is older than its interval and skips the fresh ones", async () => {
    const [firstJob, ...rest] = RETENTION_JOBS;
    const beats: Record<string, string> = {
      [`${HEARTBEAT_KEY_PREFIX}${firstJob.jobKey}`]: isoAgo(firstJob.intervalMs + 60_000),
    };
    for (const job of rest) beats[`${HEARTBEAT_KEY_PREFIX}${job.jobKey}`] = isoAgo(60_000);
    const { service, lease } = makeHarness({ heartbeats: beats });

    const outcome = await service.tick();

    expect(outcome.ran).toEqual([firstJob.jobKey]);
    expect(lease.withLease).toHaveBeenCalledTimes(1);
  });

  it("runs when the heartbeat is unparseable — an unreadable signal is not proof of a recent run", async () => {
    const junk: Record<string, string> = {};
    for (const job of RETENTION_JOBS)
      junk[`${HEARTBEAT_KEY_PREFIX}${job.jobKey}`] = "not-a-timestamp";
    const { service } = makeHarness({ heartbeats: junk });

    const outcome = await service.tick();

    expect(outcome.ran).toHaveLength(RETENTION_JOBS.length);
  });

  it("runs when Redis throws — the lease still prevents a duplicate", async () => {
    const { service, redis } = makeHarness();
    redis.get.mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await service.tick();

    expect(outcome.ran).toHaveLength(RETENTION_JOBS.length);
  });

  it("respects the cadence with no Redis at all, using the in-process last-run map", async () => {
    const lease = {
      withLease: jest.fn(
        async (_k: string, _s: number, fn: () => Promise<unknown>) => ({
          ran: true as const,
          result: await fn(),
        }),
      ),
    };
    const services = Array.from({ length: RETENTION_JOBS.length }, () => stub());
    const service = buildScheduler(null, lease as unknown as CronLeaseService, services);

    const first = await service.tick();
    const second = await service.tick();

    expect(first.ran).toHaveLength(RETENTION_JOBS.length);
    expect(second.ran).toEqual([]);
    expect(lease.withLease).toHaveBeenCalledTimes(RETENTION_JOBS.length);
  });
});

describe("CronRetentionSchedulerService — one failure must not cost the whole tick", () => {
  it("keeps running the remaining jobs when one sweep throws", async () => {
    const { service, lease } = makeHarness();
    const failingJob = RETENTION_JOBS[3].jobKey;
    lease.withLease.mockImplementation(
      async (jobKey: string, _seconds: number, fn: () => Promise<unknown>) => {
        if (jobKey === failingJob) throw new Error("boom");
        return { ran: true as const, result: await fn() };
      },
    );

    const outcome = await service.tick();

    expect(outcome.failed).toEqual([failingJob]);
    expect(outcome.ran).toHaveLength(RETENTION_JOBS.length - 1);
    expect(lease.withLease).toHaveBeenCalledTimes(RETENTION_JOBS.length);
  });

  it("counts a refused lease as skipped, not as run — a draining process hands the work on", async () => {
    const { service, lease } = makeHarness();
    lease.withLease.mockResolvedValue({ ran: false });

    const outcome = await service.tick();

    expect(outcome.ran).toEqual([]);
    expect(outcome.skipped).toHaveLength(RETENTION_JOBS.length);
  });

  it("a tick already in flight is not re-entered", async () => {
    const { service, lease } = makeHarness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    lease.withLease.mockImplementation(async () => {
      await gate;
      return { ran: true as const, result: {} };
    });

    const inFlight = service.tick();
    const reentrant = await service.tick();
    release?.();
    await inFlight;

    expect(reentrant.ran).toEqual([]);
    expect(reentrant.skipped).toEqual([]);
  });
});

describe("CronRetentionSchedulerService — enablement", () => {
  const original = process.env.RETENTION_SCHEDULER_ENABLED;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.RETENTION_SCHEDULER_ENABLED;
    else process.env.RETENTION_SCHEDULER_ENABLED = original;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("never starts a timer under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    delete process.env.RETENTION_SCHEDULER_ENABLED;
    expect(CronRetentionSchedulerService.isEnabled()).toBe(false);
  });

  it("is on by default outside tests — an opt-in scheduler nobody opts into is the defect being fixed", () => {
    process.env.NODE_ENV = "production";
    delete process.env.RETENTION_SCHEDULER_ENABLED;
    expect(CronRetentionSchedulerService.isEnabled()).toBe(true);
  });

  it("is off only when a deployment explicitly says so", () => {
    process.env.NODE_ENV = "production";
    process.env.RETENTION_SCHEDULER_ENABLED = "false";
    expect(CronRetentionSchedulerService.isEnabled()).toBe(false);
  });

  it("onModuleInit starts no timer while disabled", () => {
    process.env.NODE_ENV = "test";
    const { service } = makeHarness();
    const spy = jest.spyOn(global, "setTimeout");
    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    service.onModuleDestroy();
  });
});
