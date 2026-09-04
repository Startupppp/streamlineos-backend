import "reflect-metadata";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { NO_TENANT_TRANSACTION } from "../../common/tenant/no-tenant-transaction.decorator";
import { KbMediaController } from "./wiki/kb-media.controller";
import { KbSourcesController } from "./wiki/kb-sources.controller";
import { KbPageIndexingController } from "./retrieval/kb-page-indexing.controller";
import { KbAskController } from "./retrieval/kb-ask.controller";

/**
 * `check:idempotent-commands` is green over the whole KB module and always has been:
 * its corpus is a keyword list (`checkout|purchase|payout|…|publish|approve|…`) and no
 * AI-metered or storage-metered KB route name matches one of those words. A gate that
 * cannot see a route is not evidence about that route, so the fence lives here instead,
 * named handler by named handler. Widening that keyword list is not the fix — it would
 * report green over the same hole while fencing nothing.
 *
 * Every route below spends money on a retry that the handler's own dedupe cannot catch:
 * `POST /kb/media` mints a fresh object key per attempt, so the `onConflictDoNothing`
 * on `(org_id, file_key)` can never match a retry; the two reindex routes and `POST
 * /kb/ask` each issue provider round trips whose checkpoints only short-circuit once a
 * FIRST run has committed, which is never true of the retry racing one in flight.
 *
 * The three AI-metered routes also carry `@NoTenantTransaction()`, and that pairing used
 * to be a guaranteed 500 rather than a fence: `DrizzleCommandFenceStore` issued its
 * statements through the bare `DRIZZLE` proxy, which with no ambient transaction reaches
 * the pool carrying no tenant GUC, and `command_fences` is RLS-enabled with
 * `organization_id = current_org_id()` — the RAISING variant, not `_or_null`. The store
 * now wraps each statement in a short tenant transaction of its own keyed on the orgId it
 * already had, so the two decorators compose. `command-fence-store-no-ambient-tx.spec.ts`
 * is what pins that; this file pins that the routes are fenced at all.
 */

function commandOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler as object) as string | undefined;
}

function isNoTenantTransaction(handler: unknown): boolean {
  return Reflect.getMetadata(NO_TENANT_TRANSACTION, handler as object) === true;
}

const FENCED: ReadonlyArray<[string, unknown, string]> = [
  ["POST /kb/media", KbMediaController.prototype.upload, "kb.media.upload"],
  ["POST /kb/sources", KbSourcesController.prototype.upload, "kb.source.create"],
  ["POST /kb/sources/note", KbSourcesController.prototype.createNote, "kb.source.note"],
  [
    "POST /kb/pages/:pageId/reindex",
    KbPageIndexingController.prototype.reindexPage,
    "kb.page.reindex",
  ],
  [
    "POST /kb/pages/reindex-all",
    KbPageIndexingController.prototype.reindexAllPages,
    "kb.pages.reindex-all",
  ],
  ["POST /kb/ask", KbAskController.prototype.askQuestion, "kb.ask"],
];

/**
 * Every KB handler that spends a credit or a stored byte. A route that appears here and
 * not in FENCED is an unfenced spend, which is the defect this file exists to catch.
 */
const CREDIT_SPENDING_HANDLERS: ReadonlyArray<[string, unknown]> = [
  ["POST /kb/media", KbMediaController.prototype.upload],
  ["POST /kb/sources", KbSourcesController.prototype.upload],
  ["POST /kb/sources/note", KbSourcesController.prototype.createNote],
  ["POST /kb/pages/:pageId/reindex", KbPageIndexingController.prototype.reindexPage],
  ["POST /kb/pages/reindex-all", KbPageIndexingController.prototype.reindexAllPages],
  ["POST /kb/ask", KbAskController.prototype.askQuestion],
];

describe("KB command fencing", () => {
  describe.each(FENCED)("%s", (_route, handler, command) => {
    it(`is fenced as "${command}"`, () => {
      expect(commandOf(handler)).toBe(command);
    });
  });

  it.each(CREDIT_SPENDING_HANDLERS)("%s carries a fence", (_route, handler) => {
    expect(commandOf(handler)).toEqual(expect.any(String));
  });

  it("fences every route that spends, with no unfenced spend left over", () => {
    const fencedRoutes = FENCED.map(([route]) => route).sort();
    const spendingRoutes = CREDIT_SPENDING_HANDLERS.map(([route]) => route).sort();
    expect(fencedRoutes).toEqual(spendingRoutes);
  });

  /**
   * The three AI-metered routes must KEEP `@NoTenantTransaction()`. Each awaits a
   * provider round trip, and under the request transaction that pins a pooled
   * connection idle-in-transaction against the 60s `idle_in_transaction_session_timeout`
   * `withTenant` sets. Removing the decorator to "make the fence work" would trade a
   * billing defect for a tenant-wide outage under pool pressure.
   */
  it.each([
    ["POST /kb/pages/:pageId/reindex", KbPageIndexingController.prototype.reindexPage],
    ["POST /kb/pages/reindex-all", KbPageIndexingController.prototype.reindexAllPages],
    ["POST /kb/ask", KbAskController.prototype.askQuestion],
  ])("%s stays outside the request transaction while fenced", (_route, handler) => {
    expect(commandOf(handler)).toEqual(expect.any(String));
    expect(isNoTenantTransaction(handler)).toBe(true);
  });
});
