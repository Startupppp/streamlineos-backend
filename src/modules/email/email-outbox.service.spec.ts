import type { Db } from "../../db/drizzle.module";
import type { EmailDispatcher, EmailOptions } from "./email-provider-selection";
import { EmailOutboxService, INLINE_SEND_BUDGET_MS } from "./email-outbox.service";
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

interface SendingDouble {
  readonly db: Db;
  readonly updated: jest.Mock;
}

function sendingDouble(): SendingDouble {
  const updated = jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(undefined),
  });
  const db = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: "email-1" }]),
      }),
    }),
    update: jest.fn().mockReturnValue({ set: updated }),
  };
  return { db: db as never, updated };
}

function sendingService(
  sendEmailOnceDirect: jest.Mock,
): { service: EmailOutboxService; updated: jest.Mock } {
  const { db, updated } = sendingDouble();
  const provider: EmailDispatcher = {
    getEmailProvider: () => "zeptomail",
    sendEmailOnceDirect,
    dispatchEmail: jest.fn(),
  };
  return {
    service: new EmailOutboxService(db, suppressionStub(), provider),
    updated,
  };
}

const PLAIN_SEND: EmailOptions = {
  to: "person@example.com",
  subject: "Approval needed",
  html: "<p>approve</p>",
  organizationId: "org-1",
};

describe("EmailOutboxService.enqueueAndTry — the inline attempt holds a pooled connection", () => {
  it("bounds the inline attempt to the connection-hold budget, because the row is already durable and the cron drain owns delivery", async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { service } = sendingService(send);

    await service.enqueueAndTry({ ...PLAIN_SEND });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Approval needed" }),
      INLINE_SEND_BUDGET_MS,
    );
  });

  it("leaves the row PENDING when the inline attempt exceeds its budget, so the drain still delivers it", async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new Error("Inline email send timed out after 5000ms"));
    const { service, updated } = sendingService(send);

    await expect(service.enqueueAndTry({ ...PLAIN_SEND })).resolves.toBeUndefined();

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, nextAttemptAt: expect.any(Date) }),
    );
    expect(updated).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("gives an attachment send the full provider timeout, because the outbox row stores no attachments and the inline attempt is its only one", async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { service } = sendingService(send);

    await service.enqueueAndTry({
      ...PLAIN_SEND,
      attachments: [{ filename: "payslip.pdf", content: "x", type: "application/pdf" }],
    });

    expect(send).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("refuses to retry a send carrying headers, because the drain would redeliver it without its List-Unsubscribe", async () => {
    const send = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { service, updated } = sendingService(send);

    await expect(
      service.enqueueAndTry({
        ...PLAIN_SEND,
        headers: { "List-Unsubscribe": "<https://example.com/u/1>" },
      }),
    ).rejects.toThrow();

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("refuses to retry a cc'd send, because the outbox row stores only the primary recipient", async () => {
    const send = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { service, updated } = sendingService(send);

    await expect(
      service.enqueueAndTry({ ...PLAIN_SEND, cc: ["manager@example.com"] }),
    ).rejects.toThrow();

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("treats an empty cc array as absent, so an ordinary send is still retryable", async () => {
    const send = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { service, updated } = sendingService(send);

    await expect(
      service.enqueueAndTry({ ...PLAIN_SEND, cc: [] }),
    ).resolves.toBeUndefined();

    expect(updated).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });
});

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
        { to: "one@example.com", subject: "One", html: "one", organizationId: "org-1" },
        { to: "two@example.com", subject: "Two", html: "two", organizationId: "org-1" },
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
      organizationId: null,
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

describe("EmailOutboxService and the organization a send belongs to", () => {
  function serviceThatRecords(rows: Record<string, unknown>[]) {
    const values = jest.fn().mockImplementation((row: Record<string, unknown>) => {
      rows.push(row);
      return Promise.resolve();
    });
    return new EmailOutboxService(
      { insert: jest.fn().mockReturnValue({ values }) } as never,
      { findSuppressed: jest.fn().mockResolvedValue(new Set(["blocked@example.com"])) } as never,
      { sendEmailOnceDirect: jest.fn().mockResolvedValue(undefined) } as never,
    );
  }

  it("refuses a send with neither an organization nor a tenant context, rather than attributing it to no tenant", async () => {
    await expect(
      serviceThatRecords([]).enqueueOnly({
        to: "blocked@example.com",
        subject: "Approval needed",
        html: "<p>approve</p>",
      }),
    ).rejects.toThrow(/no organization to attribute this send to/);
  });

  it("accepts mail that says it has no tenant, so verification and password-reset still send", async () => {
    const rows: Record<string, unknown>[] = [];
    await serviceThatRecords(rows).enqueueOnly({
      to: "blocked@example.com",
      subject: "Verify your email",
      html: "<p>verify</p>",
      organizationId: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, scope: "PLATFORM" });
  });
});
