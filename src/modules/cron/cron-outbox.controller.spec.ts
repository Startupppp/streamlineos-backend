import { CronOutboxController } from "./cron-outbox.controller";

jest.mock("./cron-secret", () => ({ assertCronSecret: jest.fn() }));

describe("CronOutboxController", () => {
  it("leases and flushes the generic outbox through the scheduler entry point", async () => {
    const publisher = { flush: jest.fn().mockResolvedValue({ claimed: 1, delivered: 1, suppressed: 0, retried: 0, dead: 0 }) };
    const lease = { withLease: jest.fn().mockImplementation(async (_key: string, _seconds: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })) };
    const controller = new CronOutboxController(publisher as never, lease as never);

    const result = await controller.runPost(undefined);

    expect(result).toMatchObject({ success: true, delivered: 1 });
    expect(lease.withLease).toHaveBeenCalledWith("outbox-events-worker", 120, expect.any(Function));
    expect(publisher.flush).toHaveBeenCalledTimes(1);
  });
});
