import { ConflictException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { aiActionProposals } from "../../../db/schema/ai/ai-confirmation";
import { AiConfirmationService } from "./ai-confirmation.service";
import {
  derivedIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  stableHash,
} from "./ai-confirmation.helpers";

/**
 * The reported production defect: the assistant says "waiting for your
 * confirmation", the user types "Yes", the model calls the same tool again, and
 * `propose` mints a second row and a second token. Every retry costs a row, an
 * orphaned PROPOSED proposal and the credits the turn burned.
 *
 * `propose` supported an idempotency key and not one of the fourteen tools
 * passed one, so the dedupe branch was dead in production. The key is now
 * derived inside `propose` from what makes two proposals the same action —
 * organisation, person, action and the stable hash of the payload — so every
 * caller gets it without touching a tool file.
 *
 * The fake below honours each WHERE by reading its compiled parameters, because
 * a mock that returns its seed row regardless of predicate would pass whether
 * the key matched or not, and enforces the partial unique index the table
 * carries — `(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL` — so
 * a collision is a real collision.
 */

process.env.AI_CONFIRMATION_SECRET = "test-secret-for-unit-tests-xxxxxxxxxxxxx";

const dialect = new PgDialect();
const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";
const ACTION = "calendar.createReminder";
const PAYLOAD = { title: "Call the dentist", at: "2026-09-20T09:00:00.000Z" };
const MEMBERSHIP_ID = 42;
const DERIVED_KEY = derivedIdempotencyKey(ORG, USER, ACTION, stableHash(PAYLOAD));

type Status = "PROPOSED" | "CONFIRMED" | "EXECUTED" | "EXPIRED" | "CANCELLED";

interface Row {
  id: number;
  orgId: string;
  userId: string;
  userMembershipId: number | null;
  action: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: Status;
  idempotencyKey: string | null;
  expiresAt: Date;
  executedAt: Date | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

type InsertValues = Pick<
  Row,
  | "orgId"
  | "userId"
  | "userMembershipId"
  | "action"
  | "payload"
  | "payloadHash"
  | "idempotencyKey"
  | "expiresAt"
>;

function compile(condition: unknown): { text: string; params: unknown[] } {
  if (typeof condition !== "object" || condition === null || !("queryChunks" in condition))
    return { text: "", params: [] };
  const query = dialect.sqlToQuery(condition as SQL);
  return { text: query.sql, params: query.params };
}

function matches(row: Row, condition: unknown): boolean {
  const { text, params } = compile(condition);
  if (text === "") return false;
  if (text.includes('"org_id"') && !params.includes(row.orgId)) return false;
  if (text.includes('"id"') && !params.includes(row.id)) return false;
  if (text.includes('"status"') && !params.includes(row.status)) return false;
  if (
    text.includes('"idempotency_key"') &&
    !(row.idempotencyKey !== null && params.includes(row.idempotencyKey))
  )
    return false;
  return true;
}

function seedRow(overrides: Partial<Row> = {}): Row {
  const now = new Date();
  return {
    id: 1,
    orgId: ORG,
    userId: USER,
    userMembershipId: MEMBERSHIP_ID,
    action: ACTION,
    payload: PAYLOAD,
    payloadHash: stableHash(PAYLOAD),
    status: "PROPOSED",
    idempotencyKey: DERIVED_KEY,
    expiresAt: new Date(Date.now() + 120_000),
    executedAt: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harness(seed: Row[] = [], onMembershipRead?: (rows: Row[]) => void) {
  const rows: Row[] = [...seed];
  let nextId = rows.reduce((highest, row) => Math.max(highest, row.id), 0) + 1;
  const audit = { log: jest.fn() };

  const db: Record<string, unknown> = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const read = (count: number): Promise<unknown[]> => {
            if (table !== aiActionProposals) {
              onMembershipRead?.(rows);
              return Promise.resolve([{ id: MEMBERSHIP_ID }].slice(0, count));
            }
            return Promise.resolve(rows.filter((row) => matches(row, condition)).slice(0, count));
          };
          return { limit: read, for: (_mode: string) => ({ limit: read }) };
        },
      }),
    }),

    insert: (_table: unknown) => ({
      values: (values: InsertValues) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const collides = rows.some(
              (row) =>
                row.orgId === values.orgId &&
                row.idempotencyKey !== null &&
                row.idempotencyKey === values.idempotencyKey,
            );
            if (collides) return Promise.resolve([]);
            const now = new Date();
            const row: Row = {
              ...values,
              id: nextId++,
              status: "PROPOSED",
              executedAt: null,
              result: null,
              createdAt: now,
              updatedAt: now,
            };
            rows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    }),

    update: (_table: unknown) => ({
      set: (patch: Partial<Row>) => ({
        where: (condition: unknown) => {
          const matched = rows.filter((row) => matches(row, condition));
          for (const row of matched) Object.assign(row, patch);
          return Object.assign(Promise.resolve([]), {
            returning: () => Promise.resolve(matched.map((row) => ({ id: row.id }))),
          });
        },
      }),
    }),

    execute: jest.fn().mockResolvedValue([]),
    transaction: async <T>(cb: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => cb(db),
  };

  const service = new AiConfirmationService(
    db as unknown as Db,
    audit as unknown as AuditService,
  );

  return { service, rows, audit };
}

function proposeReminder(service: AiConfirmationService, overrides: Record<string, unknown> = {}) {
  return service.propose({
    orgId: ORG,
    userId: USER,
    action: ACTION,
    payload: PAYLOAD,
    ...overrides,
  });
}

describe("a repeat proposal of the same action", () => {
  it("returns the existing proposal when the model re-proposes the same action, because a duplicate row burns credits and orphans a token", async () => {
    const h = harness();

    const first = await proposeReminder(h.service);
    const second = await proposeReminder(h.service);

    expect(second.proposalId).toBe(first.proposalId);
    expect(second.token).toBe(first.token);
    expect(h.rows).toHaveLength(1);
  });

  it("does not audit a second proposal it never minted", async () => {
    const h = harness();

    await proposeReminder(h.service);
    await proposeReminder(h.service);

    expect(h.audit.log).toHaveBeenCalledTimes(1);
  });

  it("gives the reused proposal a token the confirm path accepts, so the card still works", async () => {
    const h = harness();

    const first = await proposeReminder(h.service);
    const second = await proposeReminder(h.service);

    const confirmed = await h.service.confirm({
      token: second.token,
      actor: { orgId: ORG, userId: USER },
    });
    expect(confirmed.proposalId).toBe(first.proposalId);
    expect(confirmed.payload).toEqual(PAYLOAD);
  });

  it("mints a separate proposal for a different payload, so two real reminders are not collapsed into one", async () => {
    const h = harness();

    const first = await proposeReminder(h.service);
    const second = await proposeReminder(h.service, { payload: { title: "Call the vet" } });

    expect(second.proposalId).not.toBe(first.proposalId);
    expect(h.rows).toHaveLength(2);
  });

  it("mints a separate proposal for another person's identical request, because a key that ignored the user would hand them someone else's token", async () => {
    const h = harness();

    const first = await proposeReminder(h.service);
    const second = await proposeReminder(h.service, { userId: "user-2" });

    expect(second.proposalId).not.toBe(first.proposalId);
  });

  it("mints a separate proposal for another tenant's identical request", async () => {
    const h = harness();

    const first = await proposeReminder(h.service);
    const second = await proposeReminder(h.service, { orgId: OTHER_ORG });

    expect(second.proposalId).not.toBe(first.proposalId);
  });

  it("keeps an explicit caller key ahead of the derived one, so a caller that already dedupes is unaffected", async () => {
    const h = harness();

    const first = await proposeReminder(h.service, { idempotencyKey: "tool-supplied-key" });
    const second = await proposeReminder(h.service, {
      idempotencyKey: "tool-supplied-key",
      payload: { title: "something else entirely" },
    });

    expect(second.proposalId).toBe(first.proposalId);
  });
});

describe("a proposal that is no longer live", () => {
  it("mints a fresh proposal once the previous one expired", async () => {
    const h = harness([seedRow({ expiresAt: new Date(Date.now() - 1_000) })]);

    const result = await proposeReminder(h.service);

    expect(result.proposalId).toBe(2);
    expect(h.rows).toHaveLength(2);
  });

  it.each<Status>(["CONFIRMED", "EXECUTED", "CANCELLED", "EXPIRED"])(
    "mints a fresh proposal once the previous one is %s, because the user already decided about it",
    async (status) => {
      const h = harness([seedRow({ status })]);

      const result = await proposeReminder(h.service);

      expect(result.proposalId).toBe(2);
    },
  );

  /**
   * The unique index is on `(org_id, idempotency_key)` and does not look at
   * status, so a dead row still holding the derived key would block every later
   * proposal of that same action for good.
   */
  it("releases the dead proposal's key rather than letting it block the action forever", async () => {
    const dead = seedRow({ status: "CANCELLED" });
    const h = harness([dead]);

    await proposeReminder(h.service);

    expect(dead.idempotencyKey).toBeNull();
    expect(h.rows[1]?.idempotencyKey).toBe(DERIVED_KEY);
  });
});

describe("two concurrent identical proposals", () => {
  it("resolve to one row rather than a unique-violation 500", async () => {
    const h = harness();

    const [first, second] = await Promise.all([
      proposeReminder(h.service),
      proposeReminder(h.service),
    ]);

    expect(second.proposalId).toBe(first.proposalId);
    expect(h.rows).toHaveLength(1);
  });

  /**
   * The loser's read found nothing, so it never released the key; by the time
   * it inserts, the winner's proposal has already been confirmed and cannot be
   * handed out again. That is a 409 the caller can explain, not a 500.
   */
  it("report a conflict, not a 500, when the winning proposal was spent before the loser reached its insert", async () => {
    let planted = false;
    const h = harness([], (rows) => {
      if (planted) return;
      planted = true;
      rows.push(seedRow({ status: "CONFIRMED" }));
    });

    await expect(proposeReminder(h.service)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("the derived key", () => {
  it("fits the idempotency_key column, because Ask OS already shipped a 125-character key that failed 22001", () => {
    const key = derivedIdempotencyKey(
      "871a5fd2-df81-4e79-a097-9910d6640a01",
      "3a99283a-40be-4758-953b-458548e064fa",
      "self.applyLeave",
      stableHash({ from: "2026-12-24", to: "2026-12-24" }),
    );

    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });

  it("ignores key order inside the payload, so the same reminder described twice is one proposal", () => {
    const hash = stableHash({ at: "2026-09-20T09:00:00.000Z", title: "Call the dentist" });

    expect(derivedIdempotencyKey(ORG, USER, ACTION, hash)).toBe(DERIVED_KEY);
  });
});
