jest.mock("ai", () => ({
  streamText: jest.fn(() => ({})),
  tool: jest.fn((def: unknown) => def),
  stepCountIs: jest.fn(() => () => false),
}));
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../tools/workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../tools/comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { NotFoundException } from "@nestjs/common";
import { projects } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { createTenantAwareDb, type DbWithClient } from "../../../../common/tenant/tenant-db";
import { getTenantContext } from "../../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { primeRelocationTrafficTracker } from "../../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../../db/drizzle.module";
import { actorFor, makeLedger, buildService } from "./chat-assistant-tenant-context-fixtures.spec";

/** The literal text `app.current_org_id()` raises. Matched, not paraphrased. */
const DENIED_MESSAGE =
  "no tenant context: app.organization_id is not set for this transaction";

const DENIED = /no tenant context/;

/**
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>` and which carries no `code` — the SQLSTATE is one
 * `cause` link down. Asserting on the wrapper's message would pass for any
 * failed query at all, so the catalog half reads the code off the driver error
 * through the repo's own classifier.
 */

/**
 * Builds a Drizzle-shaped builder that resolves to `rows`. Every chained method
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

  /**
   * The outcome assertion is now `rejects`, and that is the FIX being pinned,
   * not a relaxation. Conversation 77 does not belong to this actor in the model
   * below — nothing does — and `appendMessageToConversation` used to key its
   * SELECT and both UPDATEs on the bare `id`, so the turn completed and wrote
   * into a conversation the caller had no claim to. Completing is the defect;
   * a `NotFoundException` is the corrected behaviour, and it is a stricter
   * assertion than the `toBeDefined()` it replaces. The tenant-context claim
   * this test exists for is unchanged and still checked on the line below: the
   * ownership SELECT is issued, and it is issued inside a tenant transaction.
   */
  it("also carries one on the conversation-scoped append, which refuses a conversation the caller does not own", async () => {
    const { db, log } = denyingHandle();
    const svc = buildService(db, makeLedger());

    await expect(
      svc.processChat([{ role: "user", content: "hello" }], ACTOR, 77),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("untenanted");
  });
});
