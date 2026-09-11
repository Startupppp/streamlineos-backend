import { shutdownState } from "../../health/shutdown-state";
import { CronLeaseService } from "./cron-lease.service";

function makeRedis() {
  return {
    set: jest.fn().mockResolvedValue("OK"),
    eval: jest.fn().mockResolvedValue(1),
  };
}

describe("CronLeaseService — an interrupted batch is resumed, not lost or duplicated", () => {
  afterEach(() => {
    shutdownState.reset();
  });

  it("takes the lease and runs the sweep while the process is serving", async () => {
    const redis = makeRedis();
    const service = new CronLeaseService(redis as never);
    const sweep = jest.fn().mockResolvedValue("done");

    const outcome = await service.withLease("outbox-events-worker", 120, sweep);

    expect(outcome).toEqual({ ran: true, result: "done" });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("refuses the lease once the process is draining, so the work stays claimable", async () => {
    const redis = makeRedis();
    const service = new CronLeaseService(redis as never);
    const sweep = jest.fn().mockResolvedValue("done");

    shutdownState.beginDrain();
    const outcome = await service.withLease("outbox-events-worker", 120, sweep);

    expect(outcome).toEqual({ ran: false });
    expect(sweep).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses before Redis is consulted, so a lease is never taken and then abandoned", async () => {
    const service = new CronLeaseService(null);
    const sweep = jest.fn().mockResolvedValue("done");

    shutdownState.beginDrain();
    const outcome = await service.withLease("outbox-events-worker", 120, sweep);

    expect(outcome).toEqual({ ran: false });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("releases the lease with a token fence, so a slow run cannot delete a successor's lease", async () => {
    const redis = makeRedis();
    const service = new CronLeaseService(redis as never);

    await service.withLease("outbox-events-worker", 120, () => Promise.resolve("done"));

    const evalCall = redis.eval.mock.calls[0];
    expect(String(evalCall?.[0])).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    const setToken = redis.set.mock.calls[0]?.[1];
    expect(evalCall?.[2]).toEqual([setToken]);
  });

  it("leaves the lease to expire rather than re-running when a concurrent holder has it", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue(null);
    const service = new CronLeaseService(redis as never);
    const sweep = jest.fn().mockResolvedValue("done");

    const outcome = await service.withLease("outbox-events-worker", 120, sweep);

    expect(outcome).toEqual({ ran: false });
    expect(sweep).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      ex: 120,
      nx: true,
    });
  });
});
