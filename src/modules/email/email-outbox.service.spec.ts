import type { EmailDispatcher } from "./email-provider-selection";
import { EmailOutboxService } from "./email-outbox.service";
import type { EmailSuppressionService } from "./email-suppression.service";

function suppressionStub(): EmailSuppressionService {
  return {
    findSuppressed: jest.fn().mockResolvedValue(new Set<string>()),
  } as never;
}

function emailProviderStub(): EmailDispatcher {
  return {
    getEmailProvider: () => "zeptomail",
    sendEmailOnceDirect: () => Promise.resolve(),
    dispatchEmail: () => Promise.resolve(),
  };
}

describe("EmailOutboxService.enqueueForDelivery", () => {
  it("bulk-enqueues one durable row per private recipient", async () => {
    const returning = jest
      .fn()
      .mockResolvedValue([{ id: "email-1" }, { id: "email-2" }]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = { insert: jest.fn().mockReturnValue({ values }) };
    const service = new EmailOutboxService(db as never, suppressionStub(), emailProviderStub());

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
      emailProviderStub(),
    );

    await expect(
      service.enqueueForDelivery([
        { to: "one@example.com", subject: "One", html: "one" },
        { to: "two@example.com", subject: "Two", html: "two" },
      ]),
    ).rejects.toThrow("Failed to enqueue all emails");
  });
});

describe("EmailOutboxService.enqueueOnly", () => {
  it("records a suppressed recipient without queuing a pending delivery", async () => {
    const values = jest.fn().mockResolvedValue(undefined);
    const suppression = {
      findSuppressed: jest
        .fn()
        .mockResolvedValue(new Set(["blocked@example.com"])),
    };
    const service = new EmailOutboxService(
      { insert: jest.fn().mockReturnValue({ values }) } as never,
      suppression as never,
      emailProviderStub(),
    );

    await service.enqueueOnly({
      to: "blocked@example.com",
      subject: "Invitation",
      html: "invite",
    });

    expect(suppression.findSuppressed).toHaveBeenCalledWith(
      ["blocked@example.com"],
      null,
    );
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "blocked@example.com",
        status: "SUPPRESSED",
      }),
    );
  });
});
