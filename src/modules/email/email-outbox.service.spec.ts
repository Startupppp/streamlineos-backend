import { EmailOutboxService } from "./email-outbox.service";
import type { EmailSuppressionService } from "./email-suppression.service";

function suppressionStub(): EmailSuppressionService {
  return {
    findSuppressed: jest.fn().mockResolvedValue(new Set<string>()),
  } as never;
}

describe("EmailOutboxService.enqueueForDelivery", () => {
  it("bulk-enqueues one durable row per private recipient", async () => {
    const returning = jest
      .fn()
      .mockResolvedValue([{ id: "email-1" }, { id: "email-2" }]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = { insert: jest.fn().mockReturnValue({ values }) };
    const service = new EmailOutboxService(db as never, suppressionStub());

    await expect(
      service.enqueueForDelivery([
        {
          to: "one@example.com",
          subject: "Attendance report",
          html: "<p>one</p>",
          organizationId: "org-1",
        },
        {
          to: "two@example.com",
          subject: "Attendance report",
          html: "<p>two</p>",
          organizationId: "org-1",
        },
      ]),
    ).resolves.toBe(2);

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        toEmail: "one@example.com",
        organizationId: "org-1",
        status: "PENDING",
      }),
      expect.objectContaining({
        toEmail: "two@example.com",
        organizationId: "org-1",
        status: "PENDING",
      }),
    ]);
  });

  it("fails if the database does not return every queued row", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: "email-1" }]);
    const values = jest.fn().mockReturnValue({ returning });
    const service = new EmailOutboxService(
      { insert: jest.fn().mockReturnValue({ values }) } as never,
      suppressionStub(),
    );

    await expect(
      service.enqueueForDelivery([
        { to: "one@example.com", subject: "One", html: "one" },
        { to: "two@example.com", subject: "Two", html: "two" },
      ]),
    ).rejects.toThrow("Failed to enqueue all emails");
  });
});
