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
 *   SERVICE — no database, runs in the default suite; lives in
 *   `chat-assistant-tenant-context.spec.ts`, red without the fix.
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
 *     APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *     DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *     PGSSLMODE=disable TZ=Asia/Kolkata \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="chat-assistant-tenant-context"
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
import { createTenantAwareDb, type DbWithClient } from "../../../../common/tenant/tenant-db";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ChatHistoryService } from "./chat-history.service";
import { fetchChatContext } from "./chat-assistant-context";
import { actorFor, makeLedger, buildService, sqlstateOfRejection } from "./chat-assistant-tenant-context-fixtures";

/** The SQLSTATE `app.current_org_id()` raises with. */
const INSUFFICIENT_PRIVILEGE = "42501";

const suffix = randomUUID().slice(0, 8);
const DB_ORG = `aichat-${suffix}`;
const DB_USER = `aichat-user-${suffix}`;

describe("Ask-OS chat against a live Postgres as the app role (CATALOG)", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: DbWithClient;
  let membershipId: number;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error(
        "DATABASE_URL (owner, seeds) and APP_DATABASE_URL (the non-owner RLS role) are both required",
      );

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appDb = createTenantAwareDb(
      Object.assign(drizzle(appClient, { schema }), { __client: appClient }),
    );

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
      sqlstateOfRejection(() => fetchChatContext(appDb, DB_USER, DB_ORG, actorFor(DB_ORG, DB_USER, 1))),
    ).resolves.toBe(INSUFFICIENT_PRIVILEGE);

    await expect(
      runInNewTenantTransaction(appDb, DB_ORG, async () =>
        fetchChatContext(appDb, DB_USER, DB_ORG, actorFor(DB_ORG, DB_USER, 1)),
      ),
    ).resolves.toMatchObject({ context: { pendingLeaves: 0, recentPayrolls: [], topLeads: [] } });
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
