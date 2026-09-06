import { ForbiddenException } from "@nestjs/common";
import { NotificationConsentService } from "./notification-consent.service";
import type { Db } from "../../db/drizzle.module";

/**
 * COMP-003, the writer half. Two rows per decision: `notification_consents` is the
 * mutable current answer routing reads, `notification_consent_events` is the
 * append-only record §20 requires, which a table carrying a mutable `state` cannot
 * be on its own. A writer that updated only the first would leave the audit trail
 * empty; one that wrote only the second would leave routing blind.
 */
interface Capture {
  inserts: Array<{ table: string; values: unknown }>;
  updates: Array<{ table: string; set: unknown }>;
  conflictTargets: unknown[];
}

function tableName(table: unknown): string {
  if (typeof table !== "object" || table === null) return "unknown";
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    if (!symbol.toString().includes("Name")) continue;
    const value = Reflect.get(table, symbol);
    if (typeof value === "string") return value;
  }
  return "unknown";
}

function makeDb(updateReturning: Array<{ destination: string }> = []): {
  db: Db;
  capture: Capture;
} {
  const capture: Capture = { inserts: [], updates: [], conflictTargets: [] };

  const tx = {
    insert: (table: unknown) => {
      const name = tableName(table);
      return {
        values: (values: unknown) => {
          capture.inserts.push({ table: name, values });
          const node = {
            onConflictDoUpdate: (config: { target?: unknown }) => {
              capture.conflictTargets.push(config.target);
              return node;
            },
            returning: () =>
              Promise.resolve([
                {
                  channel: "SMS",
                  destination: "+15550000",
                  state: "GRANTED",
                  source: "USER",
                  legalBasis: "CONSENT",
                  grantedAt: new Date(),
                  withdrawnAt: null,
                  updatedAt: new Date(),
                },
              ]),
            then: (resolve: (value: unknown) => unknown) => resolve(undefined),
          };
          return node;
        },
      };
    },
    update: (table: unknown) => ({
      set: (values: unknown) => {
        capture.updates.push({ table: tableName(table), set: values });
        return {
          where: () => ({ returning: () => Promise.resolve(updateReturning) }),
        };
      },
    }),
  };

  const db = {
    // A transaction mock MUST invoke its callback — a bare jest.fn() silently voids
    // every assertion inside it (backend CLAUDE.md §8).
    transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as Db;

  return { db, capture };
}

describe("NotificationConsentService", () => {
  it("writes the current state and the append-only event together", async () => {
    const { db, capture } = makeDb();
    const svc = new NotificationConsentService(db);

    await svc.record("org-1", "user-1", 42, {
      channel: "SMS",
      destination: "+15550000",
      state: "GRANTED",
    });

    const tables = capture.inserts.map((i) => i.table);
    expect(tables).toContain("notification_consents");
    expect(tables).toContain("notification_consent_events");
  });

  it("upserts on the identity of the consent, not on a fresh row each time", async () => {
    const { db, capture } = makeDb();
    const svc = new NotificationConsentService(db);

    await svc.record("org-1", "user-1", 42, {
      channel: "SMS",
      destination: "+15550000",
      state: "GRANTED",
    });

    expect(capture.conflictTargets).toHaveLength(1);
    expect(Array.isArray(capture.conflictTargets[0])).toBe(true);
  });

  it("refuses to record consent for a caller with no membership", async () => {
    const { db } = makeDb();
    const svc = new NotificationConsentService(db);

    await expect(
      svc.record("org-1", "user-1", null, {
        channel: "SMS",
        destination: "+15550000",
        state: "GRANTED",
      }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      svc.record("org-1", "user-1", null, {
        channel: "SMS",
        destination: "+15550000",
        state: "GRANTED",
      }),
    ).rejects.toThrow("Organization membership required");
  });

  it("withdrawing flips the live row and appends its own event", async () => {
    const { db, capture } = makeDb([{ destination: "+15550000" }]);
    const svc = new NotificationConsentService(db);

    const count = await svc.withdrawChannel("org-1", "user-1", 42, "SMS");

    expect(count).toBe(1);
    expect(capture.updates[0]?.table).toBe("notification_consents");
    expect(capture.updates[0]?.set).toMatchObject({ state: "WITHDRAWN", grantedAt: null });
    expect(capture.inserts.map((i) => i.table)).toEqual(["notification_consent_events"]);
  });

  it("writes no event when there was nothing to withdraw", async () => {
    const { db, capture } = makeDb([]);
    const svc = new NotificationConsentService(db);

    const count = await svc.withdrawChannel("org-1", "user-1", 42, "SMS");

    expect(count).toBe(0);
    expect(capture.inserts).toEqual([]);
  });
});
