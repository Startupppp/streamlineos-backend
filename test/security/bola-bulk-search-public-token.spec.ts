import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { SignBulkSendService } from "src/modules/e-sign/sign-bulk-send.service";
import type { SignAuditService } from "src/modules/e-sign/sign-audit.service";
import type { SignSettingsService } from "src/modules/e-sign/sign-settings.service";
import type { SignNotificationsService } from "src/modules/e-sign/sign-notifications.service";
import type { SignTemplatesService } from "src/modules/e-sign/sign-templates.service";
import type { SignEnvelopesService } from "src/modules/e-sign/sign-envelopes.service";
import type { SignIntegrationsService } from "src/modules/e-sign/sign-integrations.service";
import type { Db } from "src/db/drizzle.module";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const ORG_ATTACKER = "org-b-attacker";
const BULK_JOB_ID = 9001;

function makeBulkSendDb(jobRow: unknown): { db: Db; capturedWhere: unknown[] } {
  const capturedWhere: unknown[] = [];
  const findFirst = jest.fn().mockImplementation((opts: unknown) => {
    const opts_ = opts as { where?: unknown } | undefined;
    if (opts_?.where !== undefined) capturedWhere.push(opts_.where);
    return Promise.resolve(jobRow);
  });
  const db = {
    query: {
      signBulkSendJobs: { findFirst },
      signBulkSendRows: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
  return { db, capturedWhere };
}

function makeSignBulkSendService(db: Db): SignBulkSendService {
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as SignAuditService;
  const settings = {} as unknown as SignSettingsService;
  const notifications = {} as unknown as SignNotificationsService;
  const templates = {} as unknown as SignTemplatesService;
  const envelopes = {} as unknown as SignEnvelopesService;
  const integrations = {} as unknown as SignIntegrationsService;
  return new SignBulkSendService(db, audit, settings, notifications, templates, envelopes, integrations);
}

describe("SignBulkSendService — cross-tenant bulk job isolation (BOLA)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("CROSS-TENANT-BULK-READ: org-B actor addressing org-A bulk job receives NotFoundException (404 not 403)", async () => {
    const { db } = makeBulkSendDb(null);
    const svc = makeSignBulkSendService(db);
    await expect(svc.getJob(ORG_ATTACKER, BULK_JOB_ID)).rejects.toThrow(NotFoundException);
  });

  it("PREDICATE-SCOPE: orgId is bound in the WHERE predicate of getJob lookup", async () => {
    const { db, capturedWhere } = makeBulkSendDb(null);
    const svc = makeSignBulkSendService(db);
    await svc.getJob(ORG_ATTACKER, BULK_JOB_ID).catch(() => {});
    const vals = capturedWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ORG_ATTACKER);
    expect(vals).toContain(BULK_JOB_ID);
  });

  it("CROSS-TENANT-CANCEL: cancel delegates to getJob and receives NotFoundException for foreign org job", async () => {
    const { db } = makeBulkSendDb(null);
    const svc = makeSignBulkSendService(db);
    await expect(svc.cancel(ORG_ATTACKER, BULK_JOB_ID, { userId: "user-b" })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("CROSS-TENANT-ERROR-REPORT: getErrorReport delegates to getJob and receives NotFoundException for foreign org job", async () => {
    const { db } = makeBulkSendDb(null);
    const svc = makeSignBulkSendService(db);
    await expect(svc.getErrorReport(ORG_ATTACKER, BULK_JOB_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("KbSearchService — ACL enforced as SQL predicate before model context (static analysis)", () => {
  const kbSearchSrc = src("src/modules/kb/retrieval/kb-search.service.ts");
  const kbCandidateSrc = src("src/modules/kb/retrieval/kb-candidate.service.ts");

  it("getAccessibleSpaceIds is called before any article query — ACL gates the candidate pool", () => {
    // Both probes are regexes, not `indexOf` on a literal. The db probe used to read
    // `indexOf("this.db.select(")` and went to -1 the moment the query was reformatted to
    // `await this.db` / `.select({…})` across two lines — a whitespace change silently
    // turned a security assertion into a failing one, and the reverse (a formatting
    // change hiding a real regression) is the same defect pointing the other way.
    // The property being asserted is unchanged: the ACL resolves before the first read.
    const accessCallPos = kbSearchSrc.search(/getAccessibleSpaceIds\s*\(\s*user\s*\)/);
    const dbSelectPos = kbSearchSrc.search(/this\.db\s*\.\s*select\s*\(/);
    expect(accessCallPos).toBeGreaterThan(-1);
    expect(dbSelectPos).toBeGreaterThan(-1);
    expect(accessCallPos).toBeLessThan(dbSelectPos);
  });

  it("early exit when no accessible spaces — prevents model call on empty tenant content", () => {
    expect(kbSearchSrc).toMatch(/ids\.length\s*===\s*0/);
    expect(kbSearchSrc).toMatch(/return\s*\{/);
  });

  it("articleKeywordCandidates binds orgId as an equality predicate", () => {
    expect(kbCandidateSrc).toMatch(/eq\s*\(\s*kbPages\.orgId\s*,\s*orgId\s*\)/);
  });

  it("articleVectorCandidates applies articleRestrictionFilter with orgId before returning candidates", () => {
    expect(kbCandidateSrc).toMatch(/articleRestrictionFilter\s*\(\s*orgId\s*,\s*principal\s*\)/);
  });

  it("both final fetches in retrieveTopArticles bind orgId, now that articles and pages share kb_pages", () => {
    const bindings = kbSearchSrc.match(/eq\s*\(\s*kbPages\.orgId\s*,\s*user\.orgId\s*\)/g) ?? [];

    expect(bindings.length).toBeGreaterThanOrEqual(2);
  });

  it("separates the two final fetches by content type, so one org-bound query cannot serve both surfaces", () => {
    expect(kbSearchSrc).toMatch(/supportArticlePredicate\s*\(\s*\)/);
    expect(kbSearchSrc).toMatch(/wikiPagePredicate\s*\(\s*\)/);
    expect(kbSearchSrc).not.toMatch(/kbArticles\./);
  });
});

describe("Sign public routes — orgId derived from DB token record not from request (static analysis)", () => {
  const signPublicSrc = src("src/modules/e-sign/sign-public.service.ts");
  // withRecipientSession moved out of the service, unchanged, into the session seam every public
  // step imports (81bdc2851); the DB-derivation checks read it there.
  const recipientSessionSrc = src("src/modules/e-sign/lib/recipient-session.ts");
  const signPublicControllerSrc = src("src/modules/e-sign/sign-public.controller.ts");

  it("withRecipientSession resolves recipient from the DB by token hash — not from URL orgId", () => {
    expect(signPublicSrc).toMatch(/import \{ withRecipientSession\b[^}]*\} from "\.\/lib\/recipient-session"/);
    expect(recipientSessionSrc).toMatch(/withPublicToken\s*\(\s*(?:this\.)?db\s*,\s*hash/);
  });

  it("tenant transaction is opened with orgId from the DB recipient row not a request parameter", () => {
    expect(recipientSessionSrc).toMatch(/orgId:\s*recipient\.orgId/);
  });

  it("sign public controller has no orgId URL parameter — token is the sole tenant selector", () => {
    expect(signPublicControllerSrc).not.toMatch(/:orgId/);
    expect(signPublicControllerSrc).toMatch(/:token/);
  });

  it("sign public controller is @Public — rate-limited by token+ip not by authenticated orgId", () => {
    expect(signPublicControllerSrc).toMatch(/@Public\(\)/);
  });
});

describe("KB public pages — token is sole tenant selector with no request orgId", () => {
  const kbPublicSrc = src("src/modules/kb/wiki/kb-public-pages.controller.ts");

  it("controller is @Public and routes by :token only — no orgId in URL", () => {
    expect(kbPublicSrc).toMatch(/@Public\(\)/);
    expect(kbPublicSrc).toMatch(/"public\/wiki"/);
    expect(kbPublicSrc).not.toMatch(/:orgId/);
  });

  it("getPublicPage called with the token value only — no orgId passed from request", () => {
    expect(kbPublicSrc).toMatch(/getPublicPage\s*\(\s*parsed\.data\s*\)/);
  });
});
