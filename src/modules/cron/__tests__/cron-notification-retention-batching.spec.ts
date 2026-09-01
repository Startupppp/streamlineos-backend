import { CronNotificationRetentionService } from "../cron-notification-retention.service";

type Batched = (run: (limit: number) => Promise<number>) => Promise<{ count: number; truncated: boolean }>;

type TestService = { batched: Batched; logger: { warn: jest.Mock } };

describe("CronNotificationRetentionService batching", () => {
  it("reports truncation when the batch safety cap is reached", async () => {
    const service = Object.assign(Object.create(CronNotificationRetentionService.prototype), {
      logger: { warn: jest.fn() },
    }) as TestService;
    const result = await service.batched(async () => 1000);
    expect(result).toEqual({ count: 100000, truncated: true });
  });

  it("reports a complete batch run when the final batch is short", async () => {
    const service = Object.assign(Object.create(CronNotificationRetentionService.prototype), {
      logger: { warn: jest.fn() },
    }) as TestService;
    const result = await service.batched(async (limit) => (limit === 1000 ? 4 : 0));
    expect(result).toEqual({ count: 4, truncated: false });
  });
});
