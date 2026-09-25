import "reflect-metadata";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { NO_TENANT_TRANSACTION } from "../../common/tenant/no-tenant-transaction.decorator";
import { KbMediaController } from "./wiki/kb-media.controller";
import { KbSourcesController } from "./wiki/kb-sources.controller";
import { KbPageIndexingController } from "./retrieval/kb-page-indexing.controller";
import { KbAskController } from "./retrieval/kb-ask.controller";
import { KbPagesController } from "./wiki/kb-pages.controller";
import { KbPageDuplicateService } from "./wiki/kb-page-duplicate.service";
import { KbPageVersionsService } from "./wiki/kb-page-versions.service";

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

  describe("retriable creates — fenced so a network retry creates exactly one resource", () => {
    const RETRIABLE_CREATES: ReadonlyArray<[string, unknown, string]> = [
      ["POST /kb/pages", KbPagesController.prototype.create, "kb.pages.create"],
      [
        "POST /kb/research-briefs/:briefId/convert-to-page",
        KbPagesController.prototype.convertBriefToPage,
        "kb.research-brief.convert-to-page",
      ],
      [
        "POST /kb/pages/:pageId/duplicate",
        KbPagesController.prototype.duplicate,
        "kb.pages.duplicate",
      ],
      [
        "POST /kb/pages/:pageId/versions/:versionNumber/restore",
        KbPagesController.prototype.restoreVersion,
        "kb.page-version.restore",
      ],
    ];

    it.each(RETRIABLE_CREATES)("%s is fenced as the correct command name", (_route, handler, expected) => {
      expect(commandOf(handler)).toBe(expected);
    });

    it("all four retriable creates are fenced — no unfenced retriable create", () => {
      for (const [route, handler] of RETRIABLE_CREATES) {
        expect(commandOf(handler)).toEqual(
          expect.any(String),
          `${route} is unfenced`,
        );
      }
    });
  });

  describe("POST /kb/pages/:pageId/duplicate — fence is load-bearing, not decorative", () => {
    const PAGE_ID = 42;
    const ORG_ID = "org-dup-fence-test";

    function makeUser() {
      return {
        orgId: ORG_ID,
        userId: "u1",
        isOrgOwner: false,
        principal: { kind: "human-session", membershipId: 1 },
      } as never;
    }

    function makeDb(transactionFn: jest.Mock) {
      return {
        query: {
          kbPages: {
            findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, orgId: ORG_ID }),
          },
        },
        transaction: transactionFn,
      };
    }

    it("the service invokes db.transaction on every call — same-key replay by the interceptor prevents the second transaction from running", async () => {
      let callCount = 0;
      const transactionFn = jest.fn().mockImplementation(async () => {
        callCount++;
        throw new Error("tx-stub");
      });
      const db = makeDb(transactionFn);
      const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
      const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined), visiblePagePredicate: jest.fn() };
      const svc = new KbPageDuplicateService(db as never, planLimits as never, auth as never);

      await svc.duplicate(makeUser(), PAGE_ID).catch(() => {});
      expect(callCount).toBe(1);
    });

    it("two unfenced calls to duplicate each open a transaction — two retries without the fence create two distinct page trees", async () => {
      let transactionCallCount = 0;
      const transactionFn = jest.fn().mockImplementation(async () => {
        transactionCallCount++;
        throw new Error("tx-stub");
      });
      const db = makeDb(transactionFn);
      const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
      const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined), visiblePagePredicate: jest.fn() };
      const svc = new KbPageDuplicateService(db as never, planLimits as never, auth as never);

      await svc.duplicate(makeUser(), PAGE_ID).catch(() => {});
      await svc.duplicate(makeUser(), PAGE_ID).catch(() => {});

      expect(transactionCallCount).toBe(2);
    });
  });

  describe("POST /kb/pages/:pageId/versions/:versionNumber/restore — fence is load-bearing, not decorative", () => {
    const PAGE_ID = 7;
    const VERSION_NUMBER = 3;
    const ORG_ID = "org-ver-fence-test";

    function makeUser() {
      return {
        orgId: ORG_ID,
        userId: "u1",
        isOrgOwner: false,
        principal: { kind: "human-session", membershipId: 2 },
      } as never;
    }

    function makeCurrentPage() {
      return {
        id: PAGE_ID,
        orgId: ORG_ID,
        isLocked: false,
        title: "Test page",
        content: null,
        contentText: null,
        fts: null,
      };
    }

    function makeVersion() {
      return {
        pageId: PAGE_ID,
        orgId: ORG_ID,
        versionNumber: VERSION_NUMBER,
        title: "Old title",
        content: null,
        contentText: null,
      };
    }

    function makeDb(transactionFn: jest.Mock) {
      return {
        query: {
          kbPages: { findFirst: jest.fn().mockResolvedValue(makeCurrentPage()) },
          kbPageVersions: { findFirst: jest.fn().mockResolvedValue(makeVersion()) },
        },
        transaction: transactionFn,
      };
    }

    it("the service invokes db.transaction on every call — same-key replay by the interceptor prevents the second transaction from running", async () => {
      let callCount = 0;
      const transactionFn = jest.fn().mockImplementation(async () => {
        callCount++;
        throw new Error("tx-stub");
      });
      const db = makeDb(transactionFn);
      const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined), visiblePagePredicate: jest.fn() };
      const svc = new KbPageVersionsService(db as never, auth as never);

      await svc.restoreVersion(makeUser(), PAGE_ID, VERSION_NUMBER, false).catch(() => {});
      expect(callCount).toBe(1);
    });

    it("two unfenced calls to restoreVersion each open a transaction — a retry without the fence creates a second snapshot row and a second audit entry", async () => {
      let transactionCallCount = 0;
      const transactionFn = jest.fn().mockImplementation(async () => {
        transactionCallCount++;
        throw new Error("tx-stub");
      });
      const db = makeDb(transactionFn);
      const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined), visiblePagePredicate: jest.fn() };
      const svc = new KbPageVersionsService(db as never, auth as never);

      await svc.restoreVersion(makeUser(), PAGE_ID, VERSION_NUMBER, false).catch(() => {});
      await svc.restoreVersion(makeUser(), PAGE_ID, VERSION_NUMBER, false).catch(() => {});

      expect(transactionCallCount).toBe(2);
    });
  });
});
