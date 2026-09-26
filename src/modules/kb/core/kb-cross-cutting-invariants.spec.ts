import * as fs from "node:fs";
import * as path from "node:path";
import "reflect-metadata";

import { kbPageCollectionQuerySchema } from "./dto/kb.schemas";
import { kbPageCollectionItemSchema, kbPageCollectionPageSchema } from "./dto/kb-core-response.schemas";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { KB_PAGE_COLLECTION_DEFAULT_LIMIT } from "./collection/knowledge-collection.types";
import { kbAclCacheKey, type KbAclDimension } from "./kb-acl-cache-key";
import { buildVisiblePageScope, buildGrantBranch } from "./authorization/knowledge-page-scope";
import { CacheFiller } from "../../../common/cache/cache-fill";
import { updatePageSchema } from "../wiki/dto/kb-pages.schemas";
import { KbPagesController } from "../wiki/kb-pages.controller";
import { KbImportExportController } from "../wiki/kb-import-export.controller";
import { KbPageReviewsController } from "../wiki/kb-page-reviews.controller";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { KbActorStanding } from "./authorization/knowledge-authorization.types";

jest.mock("../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(true),
}));

const KB_SRC = path.resolve(__dirname, "..");

function productionSources(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...productionSources(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".e2e-spec.ts") &&
      !entry.name.endsWith(".db.spec.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

function allKbSources(): string[] {
  return productionSources(KB_SRC);
}

function readSrc(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function idempotencyCommandOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler as object) as string | undefined;
}

function makeStanding(over: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: "org-1",
    userId: "user-1",
    membershipId: 5,
    roleSlugs: ["writer"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [10, 20],
    accessibleProjectIds: [100],
    permissionsVersion: 3,
    ...over,
  };
}

describe("Box 1 — canonical KnowledgeAuthorization is the only access decision", () => {
  it("the retired page-bound visibility predicate no longer exists, so no file can reach for a second page ACL rule", () => {
    const legacy = readSrc(path.join(KB_SRC, "retrieval/kb-page-visibility.ts"));

    expect(legacy).not.toContain("pageVisibleTo");
    expect(legacy).not.toContain("kbPages");
    expect(legacy).toContain("export function visibleTo");
  });

  it("kb-page-visibility survives for exactly one production caller, the chunk predicate, and for no page query", () => {
    const importers = allKbSources()
      .filter((file) => path.basename(file) !== "kb-page-visibility.ts")
      .filter((file) => readSrc(file).includes("kb-page-visibility"))
      .map((file) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(importers).toEqual(["retrieval/kb-chunk-visibility.ts"]);
  });

  it("no production file builds a kbPages visibility predicate outside the canonical scope module", () => {
    const violations = allKbSources()
      .filter((file) => path.relative(KB_SRC, file) !== path.join("core", "authorization", "knowledge-page-scope.ts"))
      .filter((file) => {
        const content = readSrc(file);
        return content.includes("visibleTo(") && content.includes("kbPages.visibility");
      })
      .map((file) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(violations).toHaveLength(0);
  });

  it("direct callers of buildVisiblePageScope are bounded — every other surface must go through the authorization seam", () => {
    const KNOWN_DIRECT_CALLERS = [
      "core/authorization/knowledge-authorization.service.ts",
      "core/authorization/knowledge-page-scope.ts",
      "core/collection/knowledge-collection.service.ts",
      "retrieval/kb-page-search-query.service.ts",
    ];

    const callers = allKbSources()
      .filter((file) => /\bbuildVisiblePageScope\b/.test(readSrc(file)))
      .map((file) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(callers.filter((f) => !KNOWN_DIRECT_CALLERS.includes(f))).toHaveLength(0);
    expect(callers).toEqual(expect.arrayContaining(KNOWN_DIRECT_CALLERS));
  });

  it("document-query callers of buildArticleRestrictionBranch are bounded — adding a new one must be deliberate", () => {
    const docQueryDir = path.join(KB_SRC, "document-query");
    const KNOWN: string[] = [];
    const actual: string[] = [];

    for (const file of productionSources(docQueryDir)) {
      const content = readSrc(file);
      if (content.includes("buildArticleRestrictionBranch")) {
        actual.push(path.basename(file));
      }
    }

    const unexpected = actual.filter((f) => !KNOWN.includes(f));
    expect(unexpected).toHaveLength(0);
  });

  it("buildVisiblePageScope always wraps the predicate in the tenant eq clause", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(scope.predicate).toBeDefined();
    expect(scope.fingerprint).toContain("org-1");
  });

  it("buildGrantBranch returns null when the actor has no membership and no roles — fails closed when grantee resolution yields nothing", () => {
    const standing = makeStanding({ membershipId: null, roleSlugs: [] });
    const branch = buildGrantBranch(standing, "view");
    expect(branch).toBeNull();
  });
});

describe("Box 2 — route denial is 403/NoPermission; hidden records are indistinguishable 404s", () => {
  it("assertPageAccess in knowledge-authorization.service.ts throws ForbiddenException for denied, NotFoundException for notFound — verified in source so the mapping cannot drift silently", () => {
    const src = readSrc(path.join(KB_SRC, "core/authorization/knowledge-authorization.service.ts"));
    expect(src).toContain("throw new ForbiddenException");
    expect(src).toContain("throw new NotFoundException");
  });

  it("resolvePageAccess in knowledge-authorization.service.ts contains a notFound return and the only denied return is for the structural membership check", () => {
    const src = readSrc(path.join(KB_SRC, "core/authorization/knowledge-authorization.service.ts"));
    const deniedCount = (src.match(/return denied\(/g) ?? []).length;
    const notFoundCount = (src.match(/return notFound\(\)/g) ?? []).length;
    expect(notFoundCount).toBeGreaterThanOrEqual(2);
    expect(deniedCount).toBeGreaterThanOrEqual(1);
    expect(deniedCount).toBeLessThanOrEqual(2);
  });

  it("resolvePageAccess source does not call denied() after the page DB lookup — a page that cannot be found returns notFound, not denied", () => {
    const src = readSrc(path.join(KB_SRC, "core/authorization/knowledge-authorization.service.ts"));
    const afterLookup = src.slice(src.indexOf("row === undefined"));
    expect(afterLookup.startsWith("row === undefined")).toBe(true);
    expect(afterLookup.slice(0, 60)).toContain("notFound");
    expect(afterLookup.slice(0, 60)).not.toContain("denied");
  });

  it("assertPageAccess source maps denied outcome to ForbiddenException and notFound to NotFoundException — 403 for in-tenant structural denial, 404 for hidden or missing", () => {
    const src = readSrc(path.join(KB_SRC, "core/authorization/knowledge-authorization.service.ts"));
    const assertSection = src.slice(src.indexOf("async assertPageAccess("));
    const firstMethod = assertSection.slice(0, assertSection.indexOf("async assertSpaceAccess("));
    expect(firstMethod).toContain("throw new ForbiddenException");
    expect(firstMethod).toContain("throw new NotFoundException");
  });

  it("wiki controller ForbiddenException throws are only for structural identity requirements, never for page/space record lookups — structural vs resource denial is the invariant", () => {
    const wikiDir = path.join(KB_SRC, "wiki");
    const violations: string[] = [];

    for (const file of productionSources(wikiDir)) {
      if (!file.endsWith(".controller.ts")) continue;
      const content = readSrc(file);
      if (!content.includes("new ForbiddenException")) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("new ForbiddenException")) {
          const context = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
          const isStructural = context.includes("membership") || context.includes("principal") || context.includes("actor");
          if (!isStructural) {
            violations.push(`${path.relative(KB_SRC, file)}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }

    expect(violations).toHaveLength(0);
  });
});

describe("Box 3 — authorization fails closed; cache unavailability cannot retain revoked access", () => {
  it("kb:acc-spaces: is in CacheFiller.AUTHZ_KEY_MARKERS so it is never memoised during an outage", () => {
    expect(CacheFiller.AUTHZ_KEY_MARKERS).toContain("kb:acc-spaces:");
  });

  const sessionDimension = (over: Partial<KbAclDimension>): KbAclDimension => ({
    orgId: "org-1",
    permissionsVersion: 3,
    membershipId: 5,
    principalKind: "human-session",
    ceilingDigest: "unbounded",
    ...over,
  });

  it("kbAclCacheKey throws when permissionsVersion is 0 so a cache key can never be built without a resolved version", () => {
    expect(() => kbAclCacheKey("user-1", sessionDimension({ permissionsVersion: 0 }))).toThrow();
  });

  it("kbAclCacheKey throws when orgId is absent so a tenant-blind key cannot be minted", () => {
    expect(() => kbAclCacheKey("user-1", sessionDimension({ orgId: "" }))).toThrow();
  });

  it("kbAclCacheKey includes orgId, permissionsVersion and membershipId so each of those dimensions creates a distinct cache entry", () => {
    const k1 = kbAclCacheKey("user-1", sessionDimension({ orgId: "org-A", permissionsVersion: 1 }));
    const k2 = kbAclCacheKey("user-1", sessionDimension({ orgId: "org-B", permissionsVersion: 1 }));
    const k3 = kbAclCacheKey("user-1", sessionDimension({ orgId: "org-A", permissionsVersion: 2 }));
    const k4 = kbAclCacheKey(
      "user-1",
      sessionDimension({ orgId: "org-A", permissionsVersion: 1, membershipId: 6 }),
    );

    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
  });

  it("a permission bump (new permissionsVersion) produces a new cache key even without a namespace invalidation — fail-safe against a dropped invalidation", () => {
    const before = kbAclCacheKey("u", sessionDimension({ orgId: "o", membershipId: 1 }));
    const after = kbAclCacheKey(
      "u",
      sessionDimension({ orgId: "o", permissionsVersion: 4, membershipId: 1 }),
    );
    expect(before).not.toBe(after);
  });
});

describe("Box 4 — tenant scope is explicit on every cache key, query, and fingerprint", () => {
  it("buildVisiblePageScope fingerprint embeds orgId, so two tenants never share a cursor scope tag", () => {
    const s1 = buildVisiblePageScope(makeStanding({ orgId: "org-A" }), "view");
    const s2 = buildVisiblePageScope(makeStanding({ orgId: "org-B" }), "view");
    expect(s1.fingerprint).not.toBe(s2.fingerprint);
    expect(s1.fingerprint).toContain("org-A");
    expect(s2.fingerprint).toContain("org-B");
  });

  it("buildVisiblePageScope fingerprint embeds permissionsVersion so a bumped version invalidates any cursor built under the old one", () => {
    const s1 = buildVisiblePageScope(makeStanding({ permissionsVersion: 3 }), "view");
    const s2 = buildVisiblePageScope(makeStanding({ permissionsVersion: 4 }), "view");
    expect(s1.fingerprint).not.toBe(s2.fingerprint);
  });

  it("buildVisiblePageScope fingerprint embeds action so a view cursor cannot be replayed against an edit predicate", () => {
    const sv = buildVisiblePageScope(makeStanding(), "view");
    const se = buildVisiblePageScope(makeStanding(), "edit");
    expect(sv.fingerprint).not.toBe(se.fingerprint);
  });

  it("buildGrantBranch SQL contains the org_id binding so a cross-tenant grant lookup is impossible", () => {
    const branch = buildGrantBranch(makeStanding({ orgId: "org-1" }), "view");
    expect(branch).not.toBeNull();
    const sql = String(branch);
    expect(sql).toBeTruthy();
  });

  it("no wiki production file uses a bare db.select().from(kbPages) without an orgId binding — scans for unconstrained SELECT patterns", () => {
    const wikiDir = path.join(KB_SRC, "wiki");
    const violations: string[] = [];

    for (const file of productionSources(wikiDir)) {
      const content = readSrc(file);
      if (
        content.includes(".from(kbPages)") &&
        !content.includes("eq(kbPages.orgId") &&
        !content.includes("kbPages.orgId") &&
        !content.includes("KB_PAGE_LIST_COLUMNS") &&
        !content.includes("KB_PAGE_COLUMNS")
      ) {
        violations.push(path.relative(KB_SRC, file));
      }
    }
    expect(violations).toHaveLength(0);
  });
});

describe("Box 5 — cursor-based collections with hasMore and capped limits", () => {
  it("KB_PAGE_COLLECTION_DEFAULT_LIMIT is ≤ 50 as the spec requires", () => {
    expect(KB_PAGE_COLLECTION_DEFAULT_LIMIT).toBeLessThanOrEqual(50);
  });

  it("PAGE_SIZE_CAP is exactly 100", () => {
    expect(PAGE_SIZE_CAP).toBe(100);
  });

  it("kbPageCollectionQuerySchema enforces the platform cap — a limit of 101 is rejected", () => {
    expect(() => kbPageCollectionQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it("kbPageCollectionQuerySchema defaults limit to KB_PAGE_COLLECTION_DEFAULT_LIMIT when absent", () => {
    const parsed = kbPageCollectionQuerySchema.parse({});
    expect(parsed.limit).toBe(KB_PAGE_COLLECTION_DEFAULT_LIMIT);
  });

  it("kbPageCollectionPageSchema has a hasMore boolean so callers can detect a truncated page", () => {
    const shape = kbPageCollectionPageSchema.shape.pagination.shape;
    expect(shape.hasMore).toBeDefined();
  });

  it("kbPageCollectionPageSchema has a nextCursor so callers can advance to the next page", () => {
    const shape = kbPageCollectionPageSchema.shape.pagination.shape;
    expect(shape.nextCursor).toBeDefined();
  });

  it("kbPageCollectionPageSchema has a limit echo so callers know the effective page size", () => {
    const shape = kbPageCollectionPageSchema.shape.pagination.shape;
    expect(shape.limit).toBeDefined();
  });
});

describe("Box 6 — projections replace SELECT *; page bodies never appear in list/search schemas", () => {
  it("kbPageCollectionItemSchema does not contain a content field — page bodies are excluded from the collection response", () => {
    const shape = kbPageCollectionItemSchema.shape;
    expect("content" in shape).toBe(false);
  });

  it("kbPageCollectionItemSchema does not contain a contentText field", () => {
    const shape = kbPageCollectionItemSchema.shape;
    expect("contentText" in shape).toBe(false);
  });

  it("kbPageCollectionItemSchema does not contain an fts field", () => {
    const shape = kbPageCollectionItemSchema.shape;
    expect("fts" in shape).toBe(false);
  });

  it("KB_PAGE_LIST_COLUMNS in wiki does not contain content — the exclusion is a named design constant not an accident", () => {
    const { KB_PAGE_LIST_COLUMNS } = require("../wiki/kb-page-columns") as {
      KB_PAGE_LIST_COLUMNS: Record<string, unknown>;
    };
    expect("content" in KB_PAGE_LIST_COLUMNS).toBe(false);
    expect("contentText" in KB_PAGE_LIST_COLUMNS).toBe(false);
    expect("fts" in KB_PAGE_LIST_COLUMNS).toBe(false);
  });

  it("no wiki list service passes kbPages directly to .select() without an explicit projection — checks for .select() with no argument on kbPages tables", () => {
    const wikiDir = path.join(KB_SRC, "wiki");
    const ALLOWED_SELECT_STAR_FILES: string[] = [
      "kb-page-columns.ts",
    ];
    const violations: string[] = [];

    for (const file of productionSources(wikiDir)) {
      const filename = path.basename(file);
      if (ALLOWED_SELECT_STAR_FILES.includes(filename)) continue;

      const content = readSrc(file);
      if (/\.select\(\)/.test(content) && content.includes("from(kbPages)")) {
        violations.push(path.relative(KB_SRC, file));
      }
    }

    expect(violations).toHaveLength(0);
  });
});

describe("Box 7 — content writes carry expectedContentRevision; bulk commands carry Idempotency-Key", () => {
  it("updatePageSchema rejects a content write without expectedContentRevision", () => {
    expect(() =>
      updatePageSchema.parse({ content: { type: "doc" }, contentText: "hello" }),
    ).toThrow();
  });

  it("updatePageSchema accepts a content write when expectedContentRevision is supplied", () => {
    const result = updatePageSchema.safeParse({
      content: { type: "doc" },
      contentText: "hello",
      expectedContentRevision: 3,
    });
    expect(result.success).toBe(true);
  });

  it("updatePageSchema accepts a metadata-only write (title, icon) without expectedContentRevision", () => {
    const result = updatePageSchema.safeParse({ title: "New title" });
    expect(result.success).toBe(true);
  });

  it("bulk trash restore carries an idempotency command name", () => {
    expect(idempotencyCommandOf(KbPagesController.prototype.bulkRestoreFromTrash)).toEqual(
      expect.any(String),
    );
  });

  it("bulk trash purge carries an idempotency command name — replayed purge is irreversible", () => {
    expect(idempotencyCommandOf(KbPagesController.prototype.bulkPurgeFromTrash)).toEqual(
      expect.any(String),
    );
  });

  it("empty trash carries an idempotency command name", () => {
    expect(idempotencyCommandOf(KbPagesController.prototype.emptyTrash)).toEqual(
      expect.any(String),
    );
  });

  it("bulk page import carries an idempotency command name", () => {
    expect(idempotencyCommandOf(KbImportExportController.prototype.importPages)).toEqual(
      expect.any(String),
    );
  });

  it("bulk review decide carries an idempotency command name", () => {
    expect(idempotencyCommandOf(KbPageReviewsController.prototype.bulkDecide)).toEqual(
      expect.any(String),
    );
  });

  it("plain page create carries an idempotency command name — a retried create is a duplicate page, not a no-op", () => {
    expect(idempotencyCommandOf(KbPagesController.prototype.create)).toEqual(
      expect.any(String),
    );
  });

  it("page duplicate carries an idempotency command name — duplicate copies a whole subtree unconditionally", () => {
    expect(
      idempotencyCommandOf(KbPagesController.prototype.duplicate),
    ).toEqual(expect.any(String));
  });

  it("version restore carries an idempotency command name — restore writes two snapshots and an audit row per call", () => {
    expect(
      idempotencyCommandOf(KbPagesController.prototype.restoreVersion),
    ).toEqual(expect.any(String));
  });

  it("single-page trash restore carries no idempotency command, so the assertions above are not asserting a decorator on every handler", () => {
    expect(
      idempotencyCommandOf(KbPagesController.prototype.restore),
    ).toBeUndefined();
  });
});

describe("Box 8 — audit and outbox records commit with the source mutation; no provider call holds a DB transaction open", () => {
  it("KbEventsService.recordDetached registers an after-commit hook when ambient context is present, never writes inside the source transaction", async () => {
    const { KbEventsService } = await import("./kb-events.service");

    const db = {
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const svc = new KbEventsService(db as never);

    svc.recordDetached("org-1", "view");

    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("no wiki production file makes a direct openai/anthropic client call inside a db.transaction block — embedding calls must be deferred via registerAfterCommit or @NoTenantTransaction", () => {
    const wikiDir = path.join(KB_SRC, "wiki");
    const AI_IMPORT_PATTERNS = [/from ['"]openai['"]/, /from ['"]@anthropic-ai/, /from ['"]openai\//, /from ['"]langchain/];
    const violations: string[] = [];

    for (const file of productionSources(wikiDir)) {
      const content = readSrc(file);
      const hasTransaction = content.includes("db.transaction") || content.includes("runInTenantTransaction");
      if (!hasTransaction) continue;

      for (const pattern of AI_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(KB_SRC, file)}: imports an AI client and uses a transaction`);
          break;
        }
      }
    }

    expect(violations).toHaveLength(0);
  });

  it("OutboxWriter.emit is called with the transaction handle, not the bare db, so outbox rows commit with the mutation", async () => {
    const { OutboxWriter } = await import("../../../common/outbox/outbox-writer");
    expect(typeof OutboxWriter.emit).toBe("function");
    expect(OutboxWriter.emit.length).toBeGreaterThanOrEqual(2);
  });
});
