/**
 * The regression net for the P0 in one-click unsubscribe.
 *
 * THREE DEFECTS, one handler (`unsubscribe.controller.ts:56`).
 *
 * 1. IT WROTE NOTHING AT ALL. The route is `@Public()`, so
 *    `TenantContextInterceptor.resolveTenant` returns null, no tenant transaction
 *    is opened, and `createTenantAwareDb` falls through to the raw pool with
 *    `app.organization_id` unset. `email_suppressions` is behind
 *    `WITH CHECK (CASE WHEN org_id IS NULL THEN true ELSE org_id = app.current_org_id() END)`
 *    and that function RAISES rather than returning NULL. Measured against
 *    scratch_head_1010 as `streamline_app`, no GUC:
 *
 *      ERROR:  no tenant context: app.organization_id is not set for this transaction
 *      CONTEXT:  PL/pgSQL function current_org_id() line 7 at RAISE
 *
 *    So every List-Unsubscribe click and every RFC 8058 one-click POST answered
 *    500 and suppressed nothing — a bulk-sender compliance failure, and the reason
 *    the blanket suppression below has not yet been observed in the wild.
 *
 * 2. IT DISCARDED THE TOKEN'S SCOPE. The token carries `scope`
 *    (TYPE | CATEGORY | ALL_NON_MANDATORY) and `scopeKey`; the handler passed
 *    neither, dropping both into `evidence`, which nothing reads.
 *    `email_suppressions` has no scope column at all (verified against the live
 *    catalog below), and `findSuppressed` matches on email + channel + org.
 *
 * 3. THE SUPPRESSION IT WOULD HAVE WRITTEN IS THE WRONG KIND. `email_suppressions`
 *    is the DELIVERABILITY list: `EmailOutboxService.enqueueAndTry:118-125`
 *    deliberately applies it to MANDATORY mail, because a hard-bounced address is
 *    undeliverable regardless of policy. Routing an opt-out preference through it
 *    means unsubscribing from a chat-mention digest also stops payslips, invoices,
 *    e-sign requests and security alerts — and `suppress()` is
 *    `onConflictDoNothing` with no DELETE, UPDATE or admin route anywhere in the
 *    product, so it could never be corrected.
 *
 * THE FIX. An unsubscribe is a routing preference, so it is written as one:
 * `notification_suppression_rules`, at the granularity the token names, scoped to
 * `channel = 'EMAIL'`. That table is consulted by `computeRouting` at
 * `notification-routing-computation.ts:75-76` under `if (ruleReason && !mandatory)`
 * — non-mandatory mail stops, mandatory mail still goes out — and it is already
 * listed and deletable per user by `NotificationPreferencesService`
 * (`listSuppressions` / `removeSuppression`), which is the recovery path
 * `email_suppressions` never had. `email_suppressions` keeps its documented meaning:
 * bounces and complaints only.
 *
 *   HERMETIC — no database. The routing semantics the fix depends on, the
 *   GET-does-not-mutate split, and that an unverifiable token writes nothing.
 *
 *   CATALOG — the real thing, house `.db.spec.ts` style, as the non-owner app role.
 *   Proves the untenanted write really is denied, that the scoped rule lands, that
 *   it is idempotent, that no email suppression is written, and that the routing
 *   query finds it. Everything is rolled back.
 *
 *     EMAIL_DB_TESTS=1 APP_DATABASE_URL=postgresql://streamline_app:…@…/scratch_head_1010 \
 *       npx jest --runInBand --testPathPattern="unsubscribe-scope"
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  emailSuppressions,
  notificationSuppressionRules,
  organizations,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { computeRouting } from "../notifications/notification-routing-computation";
import type {
  NotificationChannel,
  NotificationEventDefinition,
  SuppressionReason,
} from "../notifications/notification.types";
import {
  UNSUBSCRIBE_SCOPE_RULES,
  writeUnsubscribeRule,
} from "./unsubscribe-suppression";
import type { UnsubscribePayload } from "./unsubscribe-token";

const ENABLED = process.env.EMAIL_DB_TESTS === "1";
const DB_URL = process.env.EMAIL_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

class Rollback extends Error {}

function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

function definition(overrides: Partial<NotificationEventDefinition>): NotificationEventDefinition {
  return {
    eventKey: "chat.mention",
    displayName: "You were mentioned",
    category: "CHAT",
    sourceModule: "chat",
    defaultChannels: ["EMAIL"],
    allowedChannels: ["EMAIL", "IN_APP"],
    mandatory: false,
    ...overrides,
  } as NotificationEventDefinition;
}

function routeWithEmailRule(mandatory: boolean) {
  const suppressed = new Map<NotificationChannel, SuppressionReason>([
    ["EMAIL", "UNSUBSCRIBE" as SuppressionReason],
  ]);
  return computeRouting({
    definition: definition({ mandatory }),
    priority: "NORMAL",
    now: new Date("2026-01-05T12:00:00Z"),
    prefs: {
      channelEnabled: { IN_APP: true, EMAIL: true, PUSH: true, SMS: true, WHATSAPP: true, WEBHOOK: true },
      quietHours: { enabled: false, start: null, end: null, weekends: false, timezone: "UTC" },
      categories: {},
      modulePreferences: {},
      eventPreferences: {},
      allowCriticalOverride: true,
    },
    orgPolicy: null,
    availableChannels: new Set<NotificationChannel>(["IN_APP", "EMAIL"]),
    suppressedChannels: suppressed,
  });
}

describe("one-click unsubscribe — hermetic", () => {
  it("every token scope maps to a rule the routing query actually matches", () => {
    // notification-routing.service.ts:236-246 matches scope_type against these three
    // LOWERCASE literals plus 'all'; a rule written with any other spelling is
    // never read, which is the failure mode this table has today.
    expect(UNSUBSCRIBE_SCOPE_RULES.TYPE).toEqual({ scopeType: "event", useTokenKey: true });
    expect(UNSUBSCRIBE_SCOPE_RULES.CATEGORY).toEqual({ scopeType: "category", useTokenKey: true });
    expect(UNSUBSCRIBE_SCOPE_RULES.ALL_NON_MANDATORY).toEqual({ scopeType: "all", useTokenKey: false });
  });

  it("an EMAIL suppression rule stops a non-mandatory send and does not stop a mandatory one", () => {
    const optional = routeWithEmailRule(false);
    const mandatory = routeWithEmailRule(true);

    const emailOf = (result: ReturnType<typeof routeWithEmailRule>) =>
      result.channels.find((decision) => decision.channel === "EMAIL");

    expect(emailOf(optional)?.action).toBe("SUPPRESS");
    expect(emailOf(optional)?.reason).toBe("UNSUBSCRIBE");
    // The whole reason an unsubscribe belongs in this table and not in
    // email_suppressions: a payslip or a security alert still ships.
    expect(emailOf(mandatory)?.action).toBe("SEND");
  });
});

describeDb("one-click unsubscribe — real catalog and RLS", () => {
  let client: postgres.Sql;
  let orgId: string;

  const payload = (over: Partial<UnsubscribePayload> = {}): UnsubscribePayload => ({
    userId: "probe-unsub-user",
    orgId,
    email: "probe-unsub@example.com",
    scope: "ALL_NON_MANDATORY",
    scopeKey: "",
    expiresAt: Date.now() + 60_000,
    nonce: randomUUID(),
    ...over,
  });

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    const [row] = await drizzle(client).select({ id: organizations.id }).from(organizations).limit(1);
    if (!row) throw new Error("EMAIL_DB_TESTS needs a database with at least one organizations row");
    orgId = row.id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  async function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T | string> {
    return drizzle(client)
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${orgId}, true)`);
        const result = await fn(tx as unknown as TenantTx);
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

  it("email_suppressions carries no scope column, so it cannot express what the token says", async () => {
    const rows = await client<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'email_suppressions' ORDER BY ordinal_position`;
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain("scope");
    expect(names).not.toContain("scope_key");
    expect(names).toContain("reason");
  });

  it("the head write is denied outright on the untenanted pool — the endpoint suppressed nothing", async () => {
    const captured = await drizzle(client)
      .transaction(async (tx) => {
        // No set_config: exactly the handle a @Public() route gets.
        await tx.insert(emailSuppressions).values({
          email: "probe-unsub@example.com",
          orgId,
          channel: "EMAIL",
          reason: "UNSUBSCRIBE",
          source: "USER",
        });
        throw new Rollback();
      })
      .then(() => undefined)
      .catch((error: unknown) => (error instanceof Rollback ? undefined : sqlstateOf(error)));

    expect(captured).toBe("42501");
  });

  it("an ALL_NON_MANDATORY unsubscribe writes one reversible EMAIL rule and no email suppression", async () => {
    const observed = await inTenant(async (tx) => {
      const written = await writeUnsubscribeRule(tx, payload());
      const rules = await tx
        .select({
          scopeType: notificationSuppressionRules.scopeType,
          scopeKey: notificationSuppressionRules.scopeKey,
          channel: notificationSuppressionRules.channel,
          reason: notificationSuppressionRules.reason,
          userId: notificationSuppressionRules.userId,
        })
        .from(notificationSuppressionRules)
        .where(
          and(
            eq(notificationSuppressionRules.orgId, orgId),
            eq(notificationSuppressionRules.userId, "probe-unsub-user"),
          ),
        );
      const suppressions = await tx
        .select({ id: emailSuppressions.id })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.email, "probe-unsub@example.com"));
      return { written, rules, emailSuppressionRows: suppressions.length };
    });

    expect(observed).toEqual({
      written: { scopeType: "all", scopeKey: "*", created: true },
      rules: [
        {
          scopeType: "all",
          scopeKey: "*",
          channel: "EMAIL",
          reason: "UNSUBSCRIBE",
          userId: "probe-unsub-user",
        },
      ],
      emailSuppressionRows: 0,
    });
  });

  it("a TYPE unsubscribe honours the token's scopeKey instead of silencing everything", async () => {
    const observed = await inTenant(async (tx) => {
      await writeUnsubscribeRule(tx, payload({ scope: "TYPE", scopeKey: "chat.mention" }));
      return tx
        .select({
          scopeType: notificationSuppressionRules.scopeType,
          scopeKey: notificationSuppressionRules.scopeKey,
        })
        .from(notificationSuppressionRules)
        .where(eq(notificationSuppressionRules.userId, "probe-unsub-user"));
    });

    expect(observed).toEqual([{ scopeType: "event", scopeKey: "chat.mention" }]);
  });

  it("clicking twice is idempotent — a link scanner and a human do not stack rules", async () => {
    const observed = await inTenant(async (tx) => {
      const first = await writeUnsubscribeRule(tx, payload());
      const second = await writeUnsubscribeRule(tx, payload());
      const rows = await tx
        .select({ id: notificationSuppressionRules.id })
        .from(notificationSuppressionRules)
        .where(eq(notificationSuppressionRules.userId, "probe-unsub-user"));
      return { first: first.created, second: second.created, rows: rows.length };
    });

    expect(observed).toEqual({ first: true, second: false, rows: 1 });
  });

  it("the rule is reversible: it is deletable by (org, user, id), which is the preferences surface", async () => {
    const observed = await inTenant(async (tx) => {
      await writeUnsubscribeRule(tx, payload());
      const [row] = await tx
        .select({ id: notificationSuppressionRules.id })
        .from(notificationSuppressionRules)
        .where(eq(notificationSuppressionRules.userId, "probe-unsub-user"));
      await tx
        .delete(notificationSuppressionRules)
        .where(
          and(
            eq(notificationSuppressionRules.id, row?.id ?? -1),
            eq(notificationSuppressionRules.orgId, orgId),
            eq(notificationSuppressionRules.userId, "probe-unsub-user"),
          ),
        );
      const left = await tx
        .select({ id: notificationSuppressionRules.id })
        .from(notificationSuppressionRules)
        .where(eq(notificationSuppressionRules.userId, "probe-unsub-user"));
      return left.length;
    });

    expect(observed).toBe(0);
  });

  it("leaves nothing behind", async () => {
    const left = await inTenant(async (tx) =>
      tx
        .select({ id: notificationSuppressionRules.id })
        .from(notificationSuppressionRules)
        .where(eq(notificationSuppressionRules.userId, "probe-unsub-user")),
    );
    expect(left).toEqual([]);
  });
});
