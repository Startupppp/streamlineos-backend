/**
 * `POST /chat` — the product-wide Ask-OS assistant — answered 500 to every
 * signed-in user in every organisation.
 *
 * THE DEFECT. `ChatAssistantController.chatAssistant` is `@NoTenantTransaction()`
 * (chat-assistant.controller.ts:239), so `TenantContextInterceptor` returns
 * `next.handle()` before it ever opens a tenant transaction
 * (tenant-context.interceptor.ts:113) and `createTenantAwareDb` therefore falls
 * through to the raw pool with no ambient context (tenant-db.ts:19-22).
 * `ChatAssistantService.processChat` then issues TWO database seams on that bare
 * handle before the provider is ever reached:
 *
 *   1. `fetchContext` → `fetchChatContext(this.db, …)`, which reads
 *      `build.projects`, `build.tickets`, `attendance`, `leave_requests`,
 *      `payroll_run_employees`, `lead_party_map` and `deals`;
 *   2. `history.append` / `history.appendToConversation`, which INSERTs the
 *      user's message into `ai_chat_messages`.
 *
 * Every one of those tables carries `relrowsecurity = t` with
 * `USING (org_id = app.current_org_id())`, and `app.current_org_id()` RAISES
 * rather than returning NULL when the GUC is unset. Measured against
 * scratch_head_1010 as the non-owner `streamline_app` role with no GUC:
 *
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *   CONTEXT:  PL/pgSQL function current_org_id() line 7 at RAISE
 *
 * The outer catch in `processChat` releases the reservation with
 * `chat_setup_error` and rethrows; `rethrowStreamRouteError` sees a non-Http
 * exception and answers 500. Ask-OS is mounted product-wide by
 * `AskOsProvider` in `components/layout/dashboard-shell.tsx`, so this is every
 * chat turn for every tenant.
 *
 * THE FIX is the shape this repo already uses on exactly this route class —
 * `SignAiService.summarizeDocument` (sign-ai.service.ts:47-58) and the six
 * handlers pinned by `metered-ai-routes-release-and-cancel.spec.ts`: open a
 * SHORT `runInTenantTransaction(this.db, fn, { orgId })` around the pre-stream
 * reads and COMMIT it before the provider round trip. Passing `orgId`
 * explicitly is what makes it open its own transaction under the handler's
 * `@NoTenantTransaction()`; an ambient context, if a caller ever has one, is
 * reused unchanged. It must NOT be the request transaction: holding a pooled
 * connection idle-in-transaction across a streaming provider call is the very
 * thing `@NoTenantTransaction()` was added to stop (PRD-C078).
 *
 * WHY THE EXISTING SPECS COULD NOT SEE IT.
 * `chat-assistant.service.spec.ts:122` does
 * `jest.spyOn(svc, "fetchContext").mockResolvedValue(STUB_CONTEXT)` and hands the
 * service `{}` for `db` plus a jest-mocked `history`; `chat-assistant-breaker.spec.ts`
 * mocks `run-in-tenant-transaction` into a pass-through so the difference between
 * "inside a tenant transaction" and "on the bare pool" is erased; and
 * `chat-assistant-stream.controller.spec.ts` mocks `processChat` outright.
 * `ai.controller.e2e-spec.ts:66` lists `POST /chat` only in the
 * 401-without-a-token table. A mock answers whatever it was told; none of them
 * can raise the policy error the real pool raises.
 *
 * The two halves below are written so that the MODEL of the database refuses an
 * untenanted read, which is the one property every existing fake gets wrong.
 *
 *   SERVICE — no database, runs in the default suite, red without the fix.
 *     Drives the real `ChatAssistantService`, the real `ChatHistoryService`, the
 *     real `fetchChatContext`, the real `createTenantAwareDb` proxy and the real
 *     `runInTenantTransaction` against a handle that denies any table access
 *     made outside an ambient tenant context, exactly as the policy does.
 *
 *   CATALOG — the real thing, in the house `.db.spec.ts` style. Proves against a
 *   live Postgres as the non-owner app role that the untenanted read and the
 *   untenanted INSERT are both denied 42501, that both succeed inside a tenant
 *   transaction, and that `processChat` completes end to end. Every write is
 *   rolled back.
 *
 *     AI_DB_TESTS=1 \
 *     APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *     DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *     PGSSLMODE=disable TZ=Asia/Kolkata \
 *     npx jest --runInBand --testPathPattern="chat-assistant-tenant-context"
 */
jest.mock("ai", () => ({
  streamText: jest.fn(() => ({})),
  tool: jest.fn((def: unknown) => def),
  stepCountIs: jest.fn(() => () => false),
}));
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../../db/schema";
import { projects } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { createTenantAwareDb, type DbWithClient } from "../../../../common/tenant/tenant-db";
import { getTenantContext } from "../../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { primeRelocationTrafficTracker } from "../../../../common/relocation/relocation-traffic-tracker";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { getPostgresErrorDetails } from "../../../../common/db/postgres-error";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";
import { ChatAssistantService } from "./chat-assistant.service";
import { ChatHistoryService } from "./chat-history.service";
import { fetchChatContext } from "./chat-assistant-context";

/** The literal text `app.current_org_id()` raises. Matched, not paraphrased. */
const DENIED_MESSAGE =
  "no tenant context: app.organization_id is not set for this transaction";

const DENIED = /no tenant context/;

/** The SQLSTATE `app.current_org_id()` raises with. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>` and which carries no `code` — the SQLSTATE is one
 * `cause` link down. Asserting on the wrapper's message would pass for any
 * failed query at all, so the catalog half reads the code off the driver error
 * through the repo's own classifier.
 */
async function sqlstateOfRejection(run: () => Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  return getPostgresErrorDetails(error).code;
}

function actorFor(orgId: string, userId: string, membershipId: number): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "ADMIN",
    permissions: [],
    isOrgOwner: false,
    sessionId: "sess_chat_guc",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 4242 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeUsageSvc(): jest.Mocked<AiUsageService> {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

/**
 * Builds the real service over a real `ChatHistoryService` on `db`. Only the
 * things the defect is not about — the credit ledger, the concurrency limiter,
 * the copilot tool sets, the provider — are stubbed. `fetchContext` is NOT
 * stubbed; the whole point is where it runs from.
 */
function buildService(db: Db, ledger: jest.Mocked<AiCreditLedger>): ChatAssistantService {
  const noop = { buildTools: jest.fn().mockReturnValue({}) };
  const toolAccess = { denyReason: jest.fn().mockResolvedValue(null) };
  const moduleRef = { get: jest.fn().mockReturnValue({ ask: jest.fn() }) };
  const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  return new ChatAssistantService(
    db,
    { ask: jest.fn(), summarize: jest.fn() } as unknown as never,
    new ChatHistoryService(db),
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    toolAccess as unknown as never,
    moduleRef as unknown as never,
    makeUsageSvc(),
    ledger,
    null,
    limiter as unknown as never,
  );
}

/* ----------------------------------------------------------------- SERVICE */

/**
 * A Drizzle-shaped builder that resolves to `rows`. Every chained method
 * (`.from`, `.innerJoin`, `.where`, `.orderBy`, `.limit`, `.values`, `.set`,
 * `.returning`) answers with itself, and awaiting it yields `rows`.
 */
function thenableChain(rows: readonly unknown[]): object {
  let chain: object;
  chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then")
          return (
            onFulfilled: (value: readonly unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(onFulfilled, onRejected);
        return () => chain;
      },
    },
  );
  return chain;
}

/** `db.query.<table>.findFirst()` / `.findMany()`, guarded like a real read. */
function relationalQuery(guard: () => void): object {
  const table = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        return async () => {
          guard();
          return prop === "findFirst" ? undefined : [];
        };
      },
    },
  );
  return new Proxy(
    {},
    { get: (_target, prop) => (typeof prop === "symbol" ? undefined : table) },
  );
}

interface DenyingHandle {
  db: Db;
  /** Statements that reached the handle, in order, tagged tenanted or not. */
  readonly log: string[];
}

/**
 * Models the one property every existing chat fake gets wrong: a statement
 * against an RLS table is REFUSED unless it carries the tenant GUC, and the GUC
 * exists only inside a tenant transaction. `execute` is unguarded because the
 * statement `withTenant` runs first is `SELECT set_config(…)`, which touches no
 * policy — that is what establishes the context for everything after it.
 */
function denyingHandle(): DenyingHandle {
  const log: string[] = [];

  const guard = (): void => {
    const tenanted = getTenantContext() !== undefined;
    log.push(tenanted ? "tenanted" : "untenanted");
    if (!tenanted) throw new Error(DENIED_MESSAGE);
  };

  const statement = (): object => {
    guard();
    return thenableChain([]);
  };

  const handle = {
    select: statement,
    insert: statement,
    update: statement,
    delete: statement,
    execute: async () => [],
    query: relationalQuery(guard),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
    __client: { end: async () => undefined },
  };

  // The single seam against a type built outside this file: a stand-in for a
  // Drizzle client, the idiom the spec suite already uses everywhere.
  return { db: createTenantAwareDb(handle as unknown as DbWithClient), log };
}

/**
 * `withTenant` refreshes the relocation-target cache on the bare pool by design —
 * `organization_relocations` carries `relrowsecurity = f`, so a real deployment
 * answers it without a GUC. Priming the cache keeps that one legitimate
 * untenanted read out of the log the assertions below read, and out of the
 * 30-second window that would otherwise make it fire in one test and not the next.
 */
beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

describe("the model of the database used below refuses an untenanted statement", () => {
  it("denies a read issued outside a tenant transaction", async () => {
    const { db } = denyingHandle();
    await expect(
      (async () => db.select().from(projects).where(eq(projects.orgId, "org")))(),
    ).rejects.toThrow(DENIED);
  });

  it("allows the same read inside one", async () => {
    const { db } = denyingHandle();
    await expect(
      runInNewTenantTransaction(db, "org", async () =>
        db.select().from(projects).where(eq(projects.orgId, "org")),
      ),
    ).resolves.toEqual([]);
  });
});

describe("ChatAssistantService.processChat carries a tenant context (SERVICE)", () => {
  const ORG = "org_chat_guc";
  const USER = "user_chat_guc";
  const ACTOR = actorFor(ORG, USER, 11);

  beforeEach(() => jest.clearAllMocks());

  it("does not 500 on the bare pool under @NoTenantTransaction()", async () => {
    const { db } = denyingHandle();
    const ledger = makeLedger();
    const svc = buildService(db, ledger);

    await expect(
      svc.processChat([{ role: "user", content: "how many open tickets do I have?" }], ACTOR),
    ).resolves.toBeDefined();

    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("issues every pre-stream statement inside a tenant transaction", async () => {
    const { db, log } = denyingHandle();
    const svc = buildService(db, makeLedger());

    await svc
      .processChat([{ role: "user", content: "hello" }], ACTOR)
      .catch(() => undefined);

    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("untenanted");
  });

  it("also carries one on the conversation-scoped append", async () => {
    const { db, log } = denyingHandle();
    const svc = buildService(db, makeLedger());

    await expect(
      svc.processChat([{ role: "user", content: "hello" }], ACTOR, 77),
    ).resolves.toBeDefined();

    expect(log).not.toContain("untenanted");
  });
});

/* ----------------------------------------------------------------- CATALOG */

const ENABLED = process.env.AI_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const DB_ORG = `aichat-${suffix}`;
const DB_USER = `aichat-user-${suffix}`;

describeDb("Ask-OS chat against a live Postgres as the app role (CATALOG)", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: DbWithClient;
  let membershipId: number;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error(
        "AI_DB_TESTS needs DATABASE_URL (owner, seeds) and APP_DATABASE_URL (the non-owner RLS role)",
      );

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appDb = createTenantAwareDb(
      Object.assign(drizzle(appClient, { schema }), { __client: appClient }),
    );

    // organizations ⇄ organization_members is circular and DEFERRABLE, so both
    // go in inside one transaction with the owner pointer corrected before commit.
    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${DB_USER}, ${`${DB_USER}@ai-chat.invalid`}, 'Ask-OS probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${DB_ORG}, 'Ask-OS probe', ${DB_ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${DB_USER}, ${DB_ORG}, 'OWNER', true) RETURNING id`;
      membershipId = Number(member?.id);
      await tx`UPDATE organizations SET owner_membership_id = ${membershipId} WHERE id = ${DB_ORG}`;
    });
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM ai_chat_messages WHERE org_id = ${DB_ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${DB_ORG}`;
      await owner`DELETE FROM users WHERE id = ${DB_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  it("REFUSES fetchChatContext on the bare pool and ALLOWS it inside a tenant transaction", async () => {
    await expect(
      sqlstateOfRejection(() => fetchChatContext(appDb, DB_USER, DB_ORG)),
    ).resolves.toBe(INSUFFICIENT_PRIVILEGE);

    await expect(
      runInNewTenantTransaction(appDb, DB_ORG, async () =>
        fetchChatContext(appDb, DB_USER, DB_ORG),
      ),
    ).resolves.toMatchObject({ pendingLeaves: 0, recentPayrolls: [], topLeads: [] });
  }, 60_000);

  it("REFUSES the chat-history INSERT on the bare pool and ALLOWS it inside one", async () => {
    const history = new ChatHistoryService(appDb);

    await expect(
      sqlstateOfRejection(() =>
        history.append(DB_ORG, DB_USER, membershipId, "user", "untenanted"),
      ),
    ).resolves.toBe(INSUFFICIENT_PRIVILEGE);

    await runInNewTenantTransaction(appDb, DB_ORG, async () =>
      history.append(DB_ORG, DB_USER, membershipId, "user", "tenanted"),
    );

    const rows = await owner<{ content: string }[]>`
      SELECT content FROM ai_chat_messages WHERE org_id = ${DB_ORG}`;
    expect(rows.map((r) => r.content)).toEqual(["tenanted"]);
  }, 60_000);

  it("completes a chat turn end to end with no tenant transaction on the request", async () => {
    const ledger = makeLedger();
    const svc = buildService(appDb, ledger);

    await expect(
      svc.processChat(
        [{ role: "user", content: "end to end" }],
        actorFor(DB_ORG, DB_USER, membershipId),
      ),
    ).resolves.toBeDefined();

    expect(ledger.release).not.toHaveBeenCalled();

    const rows = await owner<{ content: string }[]>`
      SELECT content FROM ai_chat_messages WHERE org_id = ${DB_ORG} AND content = 'end to end'`;
    expect(rows).toHaveLength(1);
  }, 60_000);
});
