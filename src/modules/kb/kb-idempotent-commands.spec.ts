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
 * named handler by named handler.
 *
 * The second block is not decoration. `DrizzleCommandFenceStore` writes `command_fences`
 * through the injected `DRIZZLE` proxy with no transaction of its own, and
 * `command_fences` is RLS-enabled with `organization_id = current_org_id()` — a function
 * that RAISES `42501` rather than returning NULL when the GUC is absent. So on a handler
 * that carries `@NoTenantTransaction()` there is no ambient tenant transaction, the
 * proxy falls through to the pool without a GUC, and the very first thing the fence does
 * is fail. Pairing the two decorators does not make a route replay-safe; it makes it
 * return 500 on every call. The pairing is banned here so nobody "finishes the job" by
 * adding the decorator to the three KB routes that still need one.
 */

function commandOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler as object) as string | undefined;
}

function isNoTenantTransaction(handler: unknown): boolean {
  return Reflect.getMetadata(NO_TENANT_TRANSACTION, handler as object) === true;
}

const FENCED: ReadonlyArray<[string, unknown, string]> = [
  [
    "POST /kb/media",
    KbMediaController.prototype.upload,
    "kb.media.upload",
  ],
  ["POST /kb/sources", KbSourcesController.prototype.upload, "kb.source.create"],
  ["POST /kb/sources/note", KbSourcesController.prototype.createNote, "kb.source.note"],
];

const ALL_KB_HANDLERS: ReadonlyArray<[string, unknown]> = [
  ["POST /kb/media", KbMediaController.prototype.upload],
  ["POST /kb/sources", KbSourcesController.prototype.upload],
  ["POST /kb/sources/note", KbSourcesController.prototype.createNote],
  ["DELETE /kb/sources/:sourceId", KbSourcesController.prototype.remove],
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

  it.each(ALL_KB_HANDLERS)(
    "%s does not pair @Idempotent with @NoTenantTransaction",
    (_route, handler) => {
      if (commandOf(handler) === undefined) return;
      expect(isNoTenantTransaction(handler)).toBe(false);
    },
  );
});
