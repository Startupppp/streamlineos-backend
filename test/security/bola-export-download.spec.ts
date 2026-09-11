import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { HrExportJobsService } from "src/modules/hr/import/hr-export-jobs.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { StorageService } from "src/modules/storage/storage.service";
import type { AccessService } from "src/modules/access/access.service";
import type { Db } from "src/db/drizzle.module";
import { MembershipStateService } from "src/common/auth/membership-state.service";
import type { AuthContextFactory } from "src/common/auth/auth-context.factory";

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
const ORG_OWNER = "org-a-owner";
const JOB_ID = "export-job-uuid-belonging-to-org-a";
const REQUESTER_ID = "user-from-org-b";

function makeSelectDb(rows: unknown[]): { db: Db; capturedWhere: unknown[] } {
  const capturedWhere: unknown[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          capturedWhere.push(w);
          return { limit: jest.fn().mockResolvedValue(rows) };
        }),
      }),
    }),
  } as unknown as Db;
  return { db, capturedWhere };
}

const auditStub = {
  log: jest.fn().mockResolvedValue(undefined),
  logCritical: jest.fn().mockResolvedValue(undefined),
} as unknown as AuditService;

const accessStub = {} as unknown as AccessService;
const membershipStub = {} as unknown as MembershipStateService;
const authContextStub = {} as unknown as AuthContextFactory;

describe("HrExportJobsService — cross-tenant export isolation (BOLA)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("CROSS-TENANT-READ: org-B actor addressing org-A export job receives NotFoundException (404 semantics, not 403)", async () => {
    const { db } = makeSelectDb([]);
    const storage = {} as unknown as StorageService;
    const svc = new HrExportJobsService(db, storage, auditStub, accessStub, membershipStub, authContextStub);
    await expect(
      svc.getForRequester(ORG_ATTACKER, REQUESTER_ID, JOB_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: cross-tenant miss is NotFoundException not ForbiddenException", async () => {
    const { db } = makeSelectDb([]);
    const storage = {} as unknown as StorageService;
    const svc = new HrExportJobsService(db, storage, auditStub, accessStub, membershipStub, authContextStub);
    const thrown = await svc
      .getForRequester(ORG_ATTACKER, REQUESTER_ID, JOB_ID)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("PREDICATE-SCOPE: caller's orgId AND requestedBy are both bound in the WHERE predicate", async () => {
    const { db, capturedWhere } = makeSelectDb([]);
    const storage = {} as unknown as StorageService;
    const svc = new HrExportJobsService(db, storage, auditStub, accessStub, membershipStub, authContextStub);
    await svc.getForRequester(ORG_ATTACKER, REQUESTER_ID, JOB_ID).catch(() => {});
    const vals = capturedWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ORG_ATTACKER);
    expect(vals).toContain(REQUESTER_ID);
    expect(vals).toContain(JOB_ID);
  });

  it("PREDICATE-SCOPE: victim org value does not appear in an attacker org lookup", async () => {
    const { db, capturedWhere } = makeSelectDb([]);
    const storage = {} as unknown as StorageService;
    const svc = new HrExportJobsService(db, storage, auditStub, accessStub, membershipStub, authContextStub);
    await svc.getForRequester(ORG_ATTACKER, REQUESTER_ID, JOB_ID).catch(() => {});
    const vals = capturedWhere.flatMap((w) => sqlValues(w));
    expect(vals).not.toContain(ORG_OWNER);
  });

  it("DOWNLOAD-ORDER: getDownload throws NotFoundException before storage.getFileStream is invoked", async () => {
    const { db } = makeSelectDb([]);
    const getFileStream = jest.fn().mockResolvedValue({ body: null, contentType: "text/csv" });
    const storage = { getFileStream, isConfigured: jest.fn().mockReturnValue(true) } as unknown as StorageService;
    const svc = new HrExportJobsService(db, storage, auditStub, accessStub, membershipStub, authContextStub);
    await expect(
      svc.getDownload(ORG_ATTACKER, REQUESTER_ID, JOB_ID),
    ).rejects.toThrow(NotFoundException);
    expect(getFileStream).not.toHaveBeenCalled();
  });
});
