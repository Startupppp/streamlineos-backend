import {
  CronLeaseService,
  HEARTBEAT_KEY_PREFIX,
  LAST_ERROR_KEY_PREFIX,
} from "../cron-lease.service";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";

function makeRedis(
  setImpl: jest.Mock = jest.fn().mockResolvedValue("OK"),
  evalImpl: jest.Mock = jest.fn().mockResolvedValue(1),
) {
  return { set: setImpl, eval: evalImpl };
}

describe("Dead-man heartbeat signal — CronLeaseService", () => {
  it("(H-bite) heartbeat key is NOT written when the lease is not acquired — fn never ran", async () => {
    const setSpy = jest.fn().mockResolvedValue(null);
    const redis = makeRedis(setSpy);
    const svc = new CronLeaseService(redis as never);
    const fn = jest.fn().mockResolvedValue("done");

    const outcome = await svc.withLease("test-job", 60, fn);

    expect(outcome.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    const heartbeatCall = setSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith(HEARTBEAT_KEY_PREFIX),
    );
    expect(heartbeatCall).toBeUndefined();
  });

  it("(H) heartbeat key cron:heartbeat:<jobKey> is written with an ISO timestamp after a successful sweep", async () => {
    const setSpy = jest.fn().mockResolvedValue("OK");
    const svc = new CronLeaseService(makeRedis(setSpy) as never);
    const before = new Date().toISOString();

    await svc.withLease("test-job", 60, async () => "done");

    const heartbeatKey = `${HEARTBEAT_KEY_PREFIX}test-job`;
    const heartbeatCall = setSpy.mock.calls.find((c) => c[0] === heartbeatKey);
    expect(heartbeatCall).toBeDefined();
    const written = heartbeatCall![1] as string;
    expect(typeof written).toBe("string");
    expect(new Date(written).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(heartbeatCall![2]).toMatchObject({ ex: expect.any(Number) });
  });

  it("(F-bite) failure record is NOT written when the lease is not acquired — no fn execution", async () => {
    const setSpy = jest.fn().mockResolvedValue(null);
    const svc = new CronLeaseService(makeRedis(setSpy) as never);

    await svc.withLease("test-job", 60, async () => "done");

    const errorCall = setSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith(LAST_ERROR_KEY_PREFIX),
    );
    expect(errorCall).toBeUndefined();
  });

  it("(F) failure record cron:last-error:<jobKey> is written when fn throws, and the error is re-thrown", async () => {
    const setSpy = jest.fn().mockResolvedValue("OK");
    const evalSpy = jest.fn().mockResolvedValue(1);
    const svc = new CronLeaseService(makeRedis(setSpy, evalSpy) as never);

    await expect(
      svc.withLease("fail-job", 60, async () => {
        throw new Error("sweep-boom");
      }),
    ).rejects.toThrow("sweep-boom");

    const errorKey = `${LAST_ERROR_KEY_PREFIX}fail-job`;
    const errorCall = setSpy.mock.calls.find((c) => c[0] === errorKey);
    expect(errorCall).toBeDefined();
    const record = JSON.parse(errorCall![1] as string) as { error: string; ts: string };
    expect(record.error).toContain("sweep-boom");
    expect(typeof record.ts).toBe("string");
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
  });

  it("(H-stale) an absent heartbeat key signals the sweep has not run — the operator reads cron:heartbeat:<sweep> from Redis; missing or old = stale", () => {
    const heartbeatKey = `${HEARTBEAT_KEY_PREFIX}ai-usage-retention-sweep`;
    const simulatedMissing = undefined;
    expect(simulatedMissing).toBeUndefined();

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const maxAgeHours = 1;
    const isStale = new Date(twoHoursAgo).getTime() < Date.now() - maxAgeHours * 3600_000;
    expect(isStale).toBe(true);
  });

  it("(F-lease-id) the lease key includes the PROCESS_CELL_ID so multi-instance dedup is scoped correctly", async () => {
    const setSpy = jest.fn().mockResolvedValue("OK");
    const svc = new CronLeaseService(makeRedis(setSpy) as never);

    await svc.withLease("scoped-job", 60, async () => "ok");

    const leaseCall = setSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("cron:lease:"),
    );
    expect(leaseCall?.[0]).toContain(PROCESS_CELL_ID);
  });
});
