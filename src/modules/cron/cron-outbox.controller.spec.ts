import { CronOutboxController } from "./cron-outbox.controller";

jest.mock("./cron-secret", () => ({ assertCronSecret: jest.fn() }));

describe("CronOutboxController", () => {
  it("leases and flushes the generic outbox through the scheduler entry point", async () => {
    const publisher = { flush: jest.fn().mockResolvedValue({ claimed: 1, delivered: 1, suppressed: 0, retried: 0, dead: 0, fenced: 0 }) };
    const lease = { withLease: jest.fn().mockImplementation(async (_key: string, _seconds: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })) };
    const controller = new CronOutboxController(publisher as never, lease as never);

    const result = await controller.runPost(undefined);

    expect(result).toMatchObject({ success: true, delivered: 1 });
    expect(lease.withLease).toHaveBeenCalledWith("outbox-events-worker", 120, expect.any(Function));
    expect(publisher.flush).toHaveBeenCalledTimes(1);
  });

  it("skips a concurrent scheduler invocation when the lease is held", async () => {
    const publisher = { flush: jest.fn() };
    const lease = { withLease: jest.fn().mockResolvedValue({ ran: false }) };
    const controller = new CronOutboxController(publisher as never, lease as never);

    await expect(controller.runGet(undefined)).resolves.toEqual({
      success: true, skipped: true, message: "outbox-events-worker already running",
    });
    expect(publisher.flush).not.toHaveBeenCalled();
    expect(lease.withLease).toHaveBeenCalledWith("outbox-events-worker", 120, expect.any(Function));
  });

  it("exposes authenticated evidence endpoints without invoking the worker", async () => {
    const report = { organizations: 1, succeeded: 1, failed: 0, reports: [] };
    const publisher = {
      flush: jest.fn(),
      metrics: jest.fn().mockResolvedValue({ pending: 1 }),
      report: jest.fn().mockResolvedValue(report),
    };
    const lease = { withLease: jest.fn() };
    const controller = new CronOutboxController(publisher as never, lease as never);

    await expect(controller.metrics("Bearer secret")).resolves.toEqual({ pending: 1 });
    await expect(controller.report("Bearer secret")).resolves.toEqual(report);
    expect(publisher.metrics).toHaveBeenCalledTimes(1);
    expect(publisher.report).toHaveBeenCalledTimes(1);
    expect(lease.withLease).not.toHaveBeenCalled();
  });
});
