import { Logger } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { createTenantAwareDb, type DbWithClient } from "../../../common/tenant/tenant-db";
import { runWithTenantContext, type AfterCommitHook } from "../../../common/tenant/tenant-context";
import { EmailOutboxService } from "../../email/email-outbox.service";
import type { EmailDispatcher } from "../../email/email-provider-selection";
import type { EmailSuppressionService } from "../../email/email-suppression.service";

const ORG_ID = "org-durability";

interface RecordedInsert {
  handle: "ambient-tx" | "pool";
  values: Record<string, unknown>;
}

function makeInsertRecorder(handle: RecordedInsert["handle"], sink: RecordedInsert[]) {
  return {
    insert: jest.fn(() => ({
      values: jest.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => ({
        returning: jest.fn(() => {
          const list = Array.isArray(rows) ? rows : [rows];
          for (const row of list) sink.push({ handle, values: row });
          return Promise.resolve(list.map((_row, index) => ({ id: `outbox-${index}` })));
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(() => {
          sink.push({ handle, values });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
}

function neverSuppressed(): EmailSuppressionService {
  return {
    findSuppressed: jest.fn(() => Promise.resolve(new Set<string>())),
  } as unknown as EmailSuppressionService;
}

function makeOutbox(
  provider: EmailDispatcher,
  sink: RecordedInsert[],
): { outbox: EmailOutboxService; ambientTx: TenantTx } {
  const poolHandle = makeInsertRecorder("pool", sink);
  const ambientHandle = makeInsertRecorder("ambient-tx", sink);
  const db = createTenantAwareDb(
    Object.assign(poolHandle, { __client: { end: () => Promise.resolve() } }) as unknown as DbWithClient,
  );
  const outbox = new EmailOutboxService(db as unknown as Db, neverSuppressed(), provider);
  jest.spyOn(outbox["logger"], "warn").mockImplementation(() => undefined);
  jest.spyOn(outbox["logger"], "error").mockImplementation(() => undefined);
  return { outbox, ambientTx: ambientHandle as unknown as TenantTx };
}

function withAmbientTransaction<T>(
  tx: TenantTx,
  hooks: AfterCommitHook[],
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    { orgId: ORG_ID, audience: "INTERNAL", tx, afterCommit: hooks },
    fn,
  );
}

describe("invitation delivery durability — the enqueue path", () => {
  it("writes the queued email through the request transaction, so a rolled-back invitation takes it with it", async () => {
    const sink: RecordedInsert[] = [];
    const dispatch = jest.fn(() => Promise.resolve());
    const { outbox, ambientTx } = makeOutbox(
      { sendEmailOnceDirect: dispatch, getEmailProvider: () => "resend" } as unknown as EmailDispatcher,
      sink,
    );

    await withAmbientTransaction(ambientTx, [], () =>
      outbox.enqueueOnly({ to: "invitee@example.com", subject: "Join", html: "<p>x</p>" }),
    );

    expect(sink).toHaveLength(1);
    expect(sink[0]?.handle).toBe("ambient-tx");
    expect(sink.some((row) => row.handle === "pool")).toBe(false);

    await outbox.enqueueOnly({ to: "invitee@example.com", subject: "Join", html: "<p>x</p>" });
    expect(sink[1]?.handle).toBe("pool");
  });

  it("writes a row the retry relay will drain, which is what makes it survive process death", async () => {
    const sink: RecordedInsert[] = [];
    const { outbox, ambientTx } = makeOutbox(
      { sendEmailOnceDirect: jest.fn(), getEmailProvider: () => "resend" } as unknown as EmailDispatcher,
      sink,
    );

    const before = Date.now();
    await withAmbientTransaction(ambientTx, [], () =>
      outbox.enqueueOnly({ to: "invitee@example.com", subject: "Join", html: "<p>x</p>" }),
    );

    const row = sink[0]?.values;
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(0);
    expect(row?.organizationId).toBe(ORG_ID);
    expect(row?.scope).toBe("TENANT");
    expect((row?.nextAttemptAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((row?.nextAttemptAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("makes no provider call while the request transaction is open", async () => {
    const sink: RecordedInsert[] = [];
    const dispatch = jest.fn(() => Promise.resolve());
    const { outbox, ambientTx } = makeOutbox(
      { sendEmailOnceDirect: dispatch, getEmailProvider: () => "resend" } as unknown as EmailDispatcher,
      sink,
    );

    await withAmbientTransaction(ambientTx, [], () =>
      outbox.enqueueOnly({ to: "invitee@example.com", subject: "Join", html: "<p>x</p>" }),
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves the try-now path's terminal row outside the relay's predicate, so its guarantee is weaker", async () => {
    const sink: RecordedInsert[] = [];
    const { outbox, ambientTx } = makeOutbox(
      {
        sendEmailOnceDirect: jest.fn(() =>
          Promise.reject(Object.assign(new Error("mailbox unavailable"), { statusCode: 422 })),
        ),
        getEmailProvider: () => "resend",
      } as unknown as EmailDispatcher,
      sink,
    );

    await expect(
      withAmbientTransaction(ambientTx, [], () =>
        outbox.enqueueAndTry({ to: "invitee@example.com", subject: "Join", html: "<p>x</p>" }),
      ),
    ).rejects.toThrow("mailbox unavailable");

    const terminal = sink[sink.length - 1]?.values;
    expect(terminal?.status).toBe("FAILED");
    expect(terminal?.status).not.toBe("PENDING");
  });
});

describe("invitation delivery durability — recording a failure", () => {
  it("records DELIVERY_FAILED outside the request transaction and never rethrows", async () => {
    jest.resetModules();
    const opened: string[] = [];
    const inserted: unknown[] = [];
    jest.doMock("../../../common/tenant/run-in-tenant-transaction", () => ({
      runInNewTenantTransaction: (
        _db: unknown,
        orgId: string,
        fn: (tx: unknown) => Promise<unknown>,
      ) => {
        opened.push(orgId);
        return fn({
          insert: () => ({
            values: (row: unknown) => {
              inserted.push(row);
              return Promise.resolve(undefined);
            },
          }),
        });
      },
    }));

    const { recordDeliveryFailure } = (await import("./invitations.helpers")) as typeof import("./invitations.helpers");
    const logger = new Logger("durability-test");
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(
      recordDeliveryFailure({} as unknown as Db, logger, ORG_ID, "inv-1", new Error("smtp down")),
    ).resolves.toBeUndefined();

    expect(opened).toEqual([ORG_ID]);
    expect(inserted).toEqual([
      {
        orgId: ORG_ID,
        invitationId: "inv-1",
        event: "DELIVERY_FAILED",
        actorMembershipId: null,
      },
    ]);

    jest.dontMock("../../../common/tenant/run-in-tenant-transaction");
    jest.resetModules();
  });
});
