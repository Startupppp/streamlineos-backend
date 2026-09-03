/**
 * `dispatch()` detached its work with a bare `void this.run(...)`.
 *
 * A promise detached with `void` inherits the AsyncLocalStorage store it was
 * created in, so `getTenantContext()` keeps answering with the REQUEST's context
 * long after the handler returned. `this.db` is the tenant-aware proxy
 * (`common/tenant/tenant-db.ts`), which resolves every call to
 * `getTenantContext().tx` whenever a context exists — so `run()`'s endpoint read
 * and its `webhook_logs` insert were issued on a transaction handle whose
 * connection `TenantContextInterceptor` had already committed and returned to
 * the pool.
 *
 * The window is not small. `run()` makes up to WEBHOOK_MAX_ATTEMPTS (5) x
 * WEBHOOK_TIMEOUT_MS (10s) outbound attempts per endpoint in chunks of
 * WEBHOOK_DISPATCH_CHUNK (8), so the insert at the end of a chunk can be issued
 * ~50 s after the request answered 200. By then that pooled connection may be
 * checked out by a different request under a different `app.organization_id`
 * GUC. Best case the write throws and the `.catch` on `dispatch` swallows it, so
 * delivery logs go silently missing; worst case it lands under another tenant.
 *
 * Every caller sits inside the request transaction — leads.service.ts:232,333;
 * deals.service.ts:384,386; employee-onboarding.service.ts:345;
 * leave-decision-effects.service.ts:60; survey-automation.service.ts:27;
 * sign-integrations.service.ts:97,110,118 — so the ambient context is always
 * present on this path. That makes `registerAfterCommit` (backend CLAUDE.md §4,
 * mechanism 3) exactly right: the hooks drain only after the transaction
 * commits, on a handle that is no longer the request's, and an endpoint that was
 * never persisted never gets a webhook.
 *
 * These tests pin the seam, not the transport. The transport is covered by
 * webhooks-dispatch-seam.spec.ts.
 */
jest.mock("../../common/logger/logger.service", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { runWithTenantContext, type TenantContext } from "../../common/tenant/tenant-context";
import type { TenantTx } from "../../db/drizzle.types";
import type { Db } from "../../db/drizzle.module";
import { WebhooksDispatchService } from "./webhooks-dispatch.service";

/** A `db` whose only job is to say whether `run()` has started reading yet. */
function countingDb(reads: { count: number }): Db {
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => {
        reads.count += 1;
        return Promise.resolve([]);
      }),
    })),
  }));
  const db: unknown = { select };
  return db as Db;
}

function contextWithHooks(hooks: TenantContext["afterCommit"]): TenantContext {
  const tx: unknown = {};
  return {
    orgId: "org-after-commit",
    audience: "INTERNAL",
    tx: tx as TenantTx,
    afterCommit: hooks,
  };
}

describe("WebhooksDispatchService.dispatch — after-commit seam", () => {
  it("defers the run instead of starting it on the request's live transaction", async () => {
    const reads = { count: 0 };
    const service = new WebhooksDispatchService(countingDb(reads));
    const afterCommit: NonNullable<TenantContext["afterCommit"]> = [];

    await runWithTenantContext(contextWithHooks(afterCommit), async () => {
      service.dispatch("org-after-commit", "lead.created", { id: 1 });
      // Yield the microtask queue: a `void this.run(...)` would already have
      // issued its endpoint read by now. This is the assertion that bites.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reads.count).toBe(0);
    expect(afterCommit).toHaveLength(1);
  });

  it("the deferred hook is the actual run — draining it issues the endpoint read", async () => {
    const reads = { count: 0 };
    const service = new WebhooksDispatchService(countingDb(reads));
    const afterCommit: NonNullable<TenantContext["afterCommit"]> = [];

    await runWithTenantContext(contextWithHooks(afterCommit), () => {
      service.dispatch("org-after-commit", "lead.created", { id: 1 });
      return Promise.resolve();
    });

    // Guards this test against passing vacuously: if `dispatch` ran inline, the
    // read below would already have happened and draining nothing would look
    // identical to draining the hook.
    expect(afterCommit).toHaveLength(1);
    expect(reads.count).toBe(0);

    for (const hook of afterCommit) await hook();

    expect(reads.count).toBe(1);
  });

  it("falls back to running inline when there is no ambient context to defer into", async () => {
    const reads = { count: 0 };
    const service = new WebhooksDispatchService(countingDb(reads));

    // No `runWithTenantContext`: a sweep or a consumer, where there is no
    // request transaction to wait for. Dropping the work here would lose the
    // webhook outright, so the fallback must still run it.
    service.dispatch("org-after-commit", "lead.created", { id: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(reads.count).toBe(1);
  });

  it("stays synchronous for the caller — the handler is never made to wait on delivery", async () => {
    const reads = { count: 0 };
    const service = new WebhooksDispatchService(countingDb(reads));
    const afterCommit: NonNullable<TenantContext["afterCommit"]> = [];

    await runWithTenantContext(contextWithHooks(afterCommit), () => {
      const value: unknown = service.dispatch("org-after-commit", "lead.created", { id: 1 });
      expect(value).toBeUndefined();
      return Promise.resolve();
    });
  });
});
