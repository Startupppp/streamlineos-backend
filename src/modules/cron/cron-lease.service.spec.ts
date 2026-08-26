import { CronLeaseService } from "./cron-lease.service";

describe("CronLeaseService", () => {
  it("runs one worker and releases only its lease token", async () => {
    const redis = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    };
    const work = jest.fn().mockResolvedValue({ delivered: 2 });

    const result = await new CronLeaseService(redis as never).withLease("outbox-events-worker", 120, work);

    expect(result).toEqual({ ran: true, result: { delivered: 2 } });
    expect(work).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("cron:lease:outbox-events-worker", expect.any(String), { ex: 120, nx: true });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
      ["cron:lease:outbox-events-worker"],
      [expect.any(String)],
    );
  });

  it("does not replay work while another scheduler invocation owns the lease", async () => {
    const redis = {
      set: jest.fn().mockResolvedValue(null),
      eval: jest.fn(),
    };
    const work = jest.fn();

    const result = await new CronLeaseService(redis as never).withLease("outbox-events-worker", 120, work);

    expect(result).toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("still invokes the worker when Redis is unavailable, preserving outbox replay safety", async () => {
    const work = jest.fn().mockResolvedValue("ok");

    await expect(new CronLeaseService(null).withLease("outbox-events-worker", 120, work))
      .resolves.toEqual({ ran: true, result: "ok" });
    expect(work).toHaveBeenCalledTimes(1);
  });
});
