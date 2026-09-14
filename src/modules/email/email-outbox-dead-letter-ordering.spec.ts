import { processRetries } from "./lib/outbox-retries";
import { Logger } from "@nestjs/common";

const MAX_ATTEMPTS = 8;

function silentLogger(): Logger {
  return {
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  } as unknown as Logger;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-1",
    organizationId: "org-1",
    scope: "TENANT",
    toEmail: "user@example.com",
    subject: "Test",
    html: "<p>Test</p>",
    text: null,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    lastError: null,
    sentAt: null,
    recipientUserId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

type UpdateSet = { status?: string; lastError?: string; attempts?: number };

function makeDb(rows: ReturnType<typeof makeRow>[]) {
  const updatedRows: Array<{ id: unknown; set: UpdateSet }> = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((setArgs: UpdateSet) => ({
        where: jest.fn().mockImplementation((_whereArg: unknown) => {
          updatedRows.push({ id: "outbox-1", set: setArgs });
          return Promise.resolve();
        }),
      })),
    }),
    _updatedRows: updatedRows,
  };
  return db;
}

function makeProvider(opts: { failWith?: Error } = {}) {
  const sentEmails: string[] = [];
  return {
    getEmailProvider: jest.fn().mockReturnValue("resend"),
    sendEmailOnceDirect: jest.fn().mockImplementation(async (o: { to: string | string[] }) => {
      if (opts.failWith) throw opts.failWith;
      const recipients = Array.isArray(o.to) ? o.to : [o.to];
      sentEmails.push(...recipients);
    }),
    dispatchEmail: jest.fn(),
    _sentEmails: sentEmails,
  };
}

describe("email outbox — dead-letter after max retries", () => {
  it("promotes a row to DEAD when newAttempts reaches MAX_ATTEMPTS (8)", async () => {
    const row = makeRow({ attempts: MAX_ATTEMPTS - 1 });
    const db = makeDb([row]);
    const provider = makeProvider({ failWith: new Error("smtp-timeout") });

    const result = await processRetries({
      db: db as never,
      logger: silentLogger(),
      emailProvider: provider,
    });

    expect(result.dead).toBe(1);
    expect(result.sent).toBe(0);

    const deadUpdate = db._updatedRows.find((u) => u.set.status === "DEAD");
    expect(deadUpdate).toBeDefined();
    expect(deadUpdate?.set.attempts).toBe(MAX_ATTEMPTS);
    expect(deadUpdate?.set.lastError).toMatch("smtp-timeout");
  });

  it("does NOT dead-letter at attempt 7 — schedules next retry instead", async () => {
    const row = makeRow({ attempts: MAX_ATTEMPTS - 2 });
    const db = makeDb([row]);
    const provider = makeProvider({ failWith: new Error("smtp-timeout") });

    const result = await processRetries({
      db: db as never,
      logger: silentLogger(),
      emailProvider: provider,
    });

    expect(result.dead).toBe(0);

    const deadUpdate = db._updatedRows.find((u) => u.set.status === "DEAD");
    expect(deadUpdate).toBeUndefined();

    const rescheduled = db._updatedRows.find((u) => u.set.status === undefined && u.set.attempts !== undefined);
    expect(rescheduled).toBeDefined();
    expect(rescheduled?.set.attempts).toBe(MAX_ATTEMPTS - 1);
  });
});

describe("email outbox — ordering: earlier nextAttemptAt processed first", () => {
  it("processes the row with the earlier nextAttemptAt before the later one", async () => {
    const t0 = new Date(Date.now() - 2000);
    const t1 = new Date(Date.now() - 1000);
    const earlyRow = makeRow({
      id: "early",
      toEmail: "early@example.com",
      nextAttemptAt: t0,
    });
    const lateRow = makeRow({
      id: "late",
      toEmail: "late@example.com",
      nextAttemptAt: t1,
    });

    const sentOrder: string[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([earlyRow, lateRow]),
            }),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const provider = {
      getEmailProvider: jest.fn().mockReturnValue("resend"),
      sendEmailOnceDirect: jest.fn().mockImplementation(async (o: { to: string | string[] }) => {
        const recipients = Array.isArray(o.to) ? o.to : [o.to];
        sentOrder.push(...recipients);
      }),
      dispatchEmail: jest.fn(),
    };

    await processRetries({
      db: db as never,
      logger: silentLogger(),
      emailProvider: provider,
    });

    expect(sentOrder[0]).toBe("early@example.com");
    expect(sentOrder[1]).toBe("late@example.com");
  });

  it("SELECT chain includes orderBy step (ORDER BY is not skipped)", async () => {
    const orderByCalled: boolean[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockImplementation((..._args: unknown[]) => {
              orderByCalled.push(true);
              return { limit: jest.fn().mockResolvedValue([]) };
            }),
          }),
        }),
      }),
      update: jest.fn(),
    };

    await processRetries({
      db: db as never,
      logger: silentLogger(),
      emailProvider: makeProvider(),
    });

    expect(orderByCalled).toHaveLength(1);
  });

  it("transport is disabled under test — no real sends through buildEmailClients", async () => {
    const { buildEmailClients } = await import("./email.provider");
    const CONFIG = {
      ZEPTOMAIL_TOKEN: "Zoho-enczapikey live-looking-token",
      ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email",
      RESEND_API_KEY: "re_live_looking_key",
    } as never;

    process.env.NODE_ENV = "test";
    delete process.env.EMAIL_ALLOW_LIVE_SEND;

    const clients = buildEmailClients(CONFIG);
    expect(clients.resend).toBeNull();
    expect(clients.zeptomail).toBeNull();
  });
});
