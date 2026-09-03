/**
 * The regression net for the P0 that let one browser's push registration keep
 * naming a person who no longer holds that browser.
 *
 * THE DEFECT. `PushService.subscribe` upserted on `endpoint` with
 *
 *     set: { p256dh: input.p256dh, auth: input.auth }
 *
 * so a conflicting row kept the FIRST subscriber's `user_id`, `org_id` and
 * `membership_id` and took the SECOND subscriber's keys. Measured against
 * scratch_head_1010 as `streamline_app` with `app.organization_id` set, both
 * probes rolled back:
 *
 *   (1) same org, second user — after U2 subscribes from the browser U1 had
 *       registered, the row still reads user_id=U1, org_id=A with U2's keys.
 *       `WebPushService.sendToUser(A, U1, …)` selects that row
 *       (web-push.service.ts:66-70) and pushes U1's notifications to U2's
 *       browser; `PushService.unsubscribe(endpoint, U2)` matches on user_id and
 *       deletes 0 rows, so U2 cannot stop it.
 *
 *   (2) same endpoint, second org — the org-A row is invisible under org-B's
 *       RLS `USING (org_id = app.current_org_id())`, so ON CONFLICT DO UPDATE
 *       raises
 *
 *         ERROR:  new row violates row-level security policy (USING expression)
 *                 for table "push_subscriptions"
 *
 *       (SQLSTATE 42501). Nothing catches it, so POST /push/subscribe answers
 *       500 deterministically once a browser has ever registered in another
 *       tenant. web-push.service.ts:53-57 documents the invariant this breaks:
 *       "a person in two organizations has a subscription row per organization".
 *
 * THE FIX has two halves, and both are needed:
 *
 *   - the `set` re-owns every column that says whose browser this is
 *     (`push-subscription-ownership.ts`), which closes (1); and
 *   - `app.claim_push_endpoint` (migration 1061) — SECURITY DEFINER, the shape
 *     0385/0386/0387/1057 already use — releases any row for that endpoint held
 *     by a DIFFERENT tenant before the insert, which closes (2). RLS hides
 *     those rows from the app role, so no statement the app role can write is
 *     able to release them.
 *
 * WHY THE EXISTING SPEC COULD NOT SEE IT. `push-tenant-isolation.spec.ts` hands
 * the service a jest mock whose `.values()` records its argument and whose
 * `.onConflictDoUpdate()` resolves to `[]`. It asserts the INSERT names the
 * caller's org — which the broken code did — and never looks at the `set`, and a
 * mock could not raise the policy error in any case. So this spec has two halves:
 *
 *   HERMETIC — no database. Compiles the production statement and asserts the
 *   emitted `do update set` re-owns user_id, org_id and membership_id, and that
 *   the index it arbitrates is declared total (which is what makes a bare target
 *   legal here, unlike chat_messages). Runs in the default suite; red at head.
 *
 *   CATALOG — the real thing, house `.db.spec.ts` style, as the non-owner app
 *   role with a real tenant GUC. Everything runs in a transaction that is rolled
 *   back.
 *
 *     PUSH_DB_TESTS=1 APP_DATABASE_URL=postgresql://streamline_app:…@…/scratch_head_1010 \
 *       npx jest --runInBand --testPathPattern="push-subscription-ownership"
 */
import { randomUUID } from "node:crypto";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { organizations, pushSubscriptions } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { PushService } from "./push.service";
import {
  PUSH_ENDPOINT_CONFLICT,
  pushSubscriptionOwnership,
} from "./push-subscription-ownership";

const ENABLED = process.env.PUSH_DB_TESTS === "1";
const DB_URL = process.env.PUSH_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

const CONFIG = { VAPID_PUBLIC_KEY: "test-key" };

class Rollback extends Error {}

/** Drizzle wraps driver errors: `err.code` is undefined and the SQLSTATE is on `.cause`. */
function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("push subscription ownership — hermetic", () => {
  it("the unique it arbitrates is declared TOTAL, which is what makes a bare target legal", () => {
    // A partial unique cannot be inferred from a bare column list (42P10 at plan
    // time — the chat_messages P0). This one is a column-level `.unique()`, so it
    // carries no predicate and needs none spelled at the call site.
    const endpoint = getTableConfig(pushSubscriptions).columns.find((c) => c.name === "endpoint");
    expect(endpoint?.isUnique).toBe(true);
    expect(
      getTableConfig(pushSubscriptions).indexes.some((index) =>
        (index as unknown as { config: { columns: Array<{ name?: string }>; where?: unknown } }).config.columns.some(
          (column) => column.name === "endpoint",
        ),
      ),
    ).toBe(false);
    expect(Object.keys(PUSH_ENDPOINT_CONFLICT)).toEqual(["target"]);
  });

  it("the upsert re-owns user_id, org_id and membership_id — the head form re-owned neither", () => {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const values = {
      userId: "u2",
      orgId: "org-b",
      endpoint: "https://fcm.example/e",
      p256dh: "p2",
      auth: "a2",
    };
    const compile = (set: Record<string, unknown>) =>
      offline.insert(pushSubscriptions).values(values).onConflictDoUpdate({
        ...PUSH_ENDPOINT_CONFLICT,
        set,
      }).toSQL().sql;

    const head = compile({ p256dh: values.p256dh, auth: values.auth });
    const shipped = compile(pushSubscriptionOwnership(values));

    expect(head).not.toContain('"user_id" =');
    expect(head).not.toContain('"org_id" =');
    expect(shipped).toContain('on conflict ("endpoint") do update set');
    expect(shipped).toContain('"user_id" =');
    expect(shipped).toContain('"org_id" =');
    expect(shipped).toContain('"membership_id" =');
  });

  it("re-ownership nulls membership_id, because (org_id, membership_id) is a composite FK", () => {
    expect(pushSubscriptionOwnership({ userId: "u", orgId: "o", p256dh: "p", auth: "a" })).toEqual({
      userId: "u",
      orgId: "o",
      membershipId: null,
      p256dh: "p",
      auth: "a",
      userAgent: null,
    });
  });
});

describeDb("push subscription ownership — real catalog and RLS", () => {
  let client: postgres.Sql;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    const rows = await drizzle(client).select({ id: organizations.id }).from(organizations).limit(2);
    if (rows.length < 2)
      throw new Error("PUSH_DB_TESTS needs a database with at least two organizations rows");
    orgA = rows[0]!.id;
    orgB = rows[1]!.id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /** Runs `fn` inside one rolled-back transaction whose tenant GUC is `orgId`. */
  async function inTenant<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T | string> {
    return drizzle(client)
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${orgId}, true)`);
        const result = await fn(tx as unknown as Db);
        throw Object.assign(new Rollback(), { result });
      })
      .then(() => {
        throw new Error("unreachable: the probe transaction must roll back");
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return (error as Rollback & { result: T }).result;
        return sqlstateOf(error) ?? String(error);
      });
  }

  it("the live endpoint unique is TOTAL, so this is not testing a different database", async () => {
    const [row] = await client<Array<{ pred: string | null; uniq: boolean }>>`
      SELECT pg_get_expr(x.indpred, x.indrelid) AS pred, x.indisunique AS uniq
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
       WHERE i.relname = 'push_subscriptions_endpoint_unique'`;
    expect(row?.uniq).toBe(true);
    expect(row?.pred).toBeNull();
    expect(getTableName(pushSubscriptions)).toBe("push_subscriptions");
  });

  it("app.claim_push_endpoint is SECURITY DEFINER and executable by the app role", async () => {
    const [row] = await client<Array<{ secdef: boolean; can_execute: boolean }>>`
      SELECT p.prosecdef AS secdef,
             has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'claim_push_endpoint'`;
    expect(row?.secdef).toBe(true);
    expect(row?.can_execute).toBe(true);
  });

  it("a second user on the same browser takes the row over, and can then unsubscribe", async () => {
    const endpoint = `https://fcm.example/own-${randomUUID()}`;
    const observed = await inTenant(orgA, async (db) => {
      const service = new PushService(db, CONFIG);
      await service.subscribe(orgA, "probe-u1", { endpoint, p256dh: "P1", auth: "A1" });
      await service.subscribe(orgA, "probe-u2", { endpoint, p256dh: "P2", auth: "A2" });

      const after = await db
        .select({
          userId: pushSubscriptions.userId,
          orgId: pushSubscriptions.orgId,
          p256dh: pushSubscriptions.p256dh,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));

      await service.unsubscribe(endpoint, "probe-u2");
      const left = await db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));

      return { rows: after.length, owner: after[0]?.userId, org: after[0]?.orgId, keys: after[0]?.p256dh, leftAfterUnsubscribe: left.length };
    });

    expect(observed).toEqual({
      rows: 1,
      owner: "probe-u2",
      org: orgA,
      keys: "P2",
      leftAfterUnsubscribe: 0,
    });
  });

  it("the head form leaves the first user owning the row — proof the net bites", async () => {
    const endpoint = `https://fcm.example/head-${randomUUID()}`;
    const observed = await inTenant(orgA, async (db) => {
      await db
        .insert(pushSubscriptions)
        .values({ userId: "probe-u1", orgId: orgA, endpoint, p256dh: "P1", auth: "A1" });
      await db
        .insert(pushSubscriptions)
        .values({ userId: "probe-u2", orgId: orgA, endpoint, p256dh: "P2", auth: "A2" })
        // The exact head form: keys only, ownership untouched.
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: "P2", auth: "A2" } });
      const after = await db
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));
      return after[0]?.userId;
    });

    expect(observed).toBe("probe-u1");
  });

  it("a browser already registered in another tenant re-registers instead of raising 42501", async () => {
    const endpoint = `https://fcm.example/cross-${randomUUID()}`;

    // Seed the org-A row and leave it committed only for the length of this probe:
    // the cross-tenant claim has to run against a row it cannot see, so the seed
    // cannot live in the same rolled-back transaction as the claim. Even the seed
    // needs a tenant GUC — `app.current_org_id()` RAISES 42501 when unset, so the
    // app role cannot touch this table at all without one.
    await client.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgA}, true)`;
      await tx`INSERT INTO push_subscriptions (user_id, org_id, endpoint, p256dh, auth)
               VALUES ('probe-u1', ${orgA}, ${endpoint}, 'P1', 'A1')`;
    });
    try {
      const observed = await inTenant(orgB, async (db) => {
        const service = new PushService(db, CONFIG);
        await service.subscribe(orgB, "probe-u1", { endpoint, p256dh: "PB", auth: "AB" });
        const after = await db
          .select({ userId: pushSubscriptions.userId, orgId: pushSubscriptions.orgId })
          .from(pushSubscriptions)
          .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.orgId, orgB)));
        return { rows: after.length, org: after[0]?.orgId, owner: after[0]?.userId };
      });

      expect(observed).toEqual({ rows: 1, org: orgB, owner: "probe-u1" });
    } finally {
      await client.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgB}, true)`;
        await tx`SELECT app.claim_push_endpoint(${endpoint})`;
        await tx`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
      });
    }
  });

  it("leaves nothing behind", async () => {
    const counts = await Promise.all(
      [orgA, orgB].map((org) =>
        client.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${org}, true)`;
          const [row] = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM push_subscriptions
             WHERE endpoint LIKE 'https://fcm.example/%'`;
          return row?.n ?? -1;
        }),
      ),
    );
    expect(counts).toEqual([0, 0]);
  });
});
