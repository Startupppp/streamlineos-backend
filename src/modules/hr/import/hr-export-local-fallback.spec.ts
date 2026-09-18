import { createHash } from "node:crypto";
import { GoneException } from "@nestjs/common";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CreateEmployeeExportJobInput } from "./dto/export-job.dto";
import {
  ephemeralFileKey,
  hrExportEphemeralStore,
} from "./hr-export-ephemeral-store";
import { HrExportJobsService } from "./hr-export-jobs.service";
import type { HrExportJobRow } from "./hr-export-jobs.types";

const ORG = "org_local";
const USER = "user_local";
const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KEY = "11111111-2222-3333-4444-555555555555";
const FILTERS: CreateEmployeeExportJobInput = {
  filters: { search: "Ada", isActive: "all" },
};

function hashOf(input: CreateEmployeeExportJobInput): string {
  return createHash("sha256").update(JSON.stringify(input.filters)).digest("hex");
}

function actor(): CurrentUserContext {
  return {
    userId: USER,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session_local",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function pendingJob(overrides: Partial<HrExportJobRow> = {}): HrExportJobRow {
  return {
    id: JOB_ID,
    orgId: ORG,
    entity: "employees",
    status: "pending",
    filters: FILTERS.filters,
    requestedScope: "all",
    requestedBy: USER,
    idempotencyKey: KEY,
    requestHash: hashOf(FILTERS),
    processedRows: 0,
    rowCount: null,
    fileKey: null,
    fileName: null,
    mimeType: null,
    fileSizeBytes: null,
    errorCode: null,
    errorMessage: null,
    attempt: 0,
    maxAttempts: 3,
    lockedAt: null,
    completedAt: null,
    expiresAt: null,
    createdAt: new Date("2024-01-15T00:00:00.000Z"),
    updatedAt: new Date("2024-01-15T00:00:00.000Z"),
    ...overrides,
  } as HrExportJobRow;
}

function authStack() {
  const membershipState = {
    resolve: jest.fn().mockResolvedValue({
      active: true,
      isOwner: false,
      role: "MEMBER",
      membershipId: 1,
    }),
  };
  const authContexts = {
    create: (context: CurrentUserContext) => ({
      actor: context,
      moduleAvailable: async () => ({ available: true }),
      membership: async () => ({
        active: true,
        isOwner: false,
        role: "MEMBER",
        membershipId: 1,
      }),
      mfa: async () => ({ enforced: false, satisfied: true }),
    }),
  };
  const access = {
    scopeFor: jest.fn().mockResolvedValue("all"),
  };
  return { membershipState, authContexts, access };
}

/**
 * Drizzle surface for the sync fallback: insert returns the pending row;
 * updates claim → complete; selects reload the completed row for the response.
 */
function syncDb(job: HrExportJobRow) {
  let current: HrExportJobRow = { ...job };
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [current],
  };

  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [current],
        }),
      }),
    }),
    select: () => selectChain,
    update: () => ({
      set: (patch: Partial<HrExportJobRow>) => ({
        where: () => ({
          returning: async () => {
            current = { ...current, ...patch, updatedAt: new Date() };
            return [current];
          },
        }),
      }),
    }),
  };

  return { db, audit, getCurrent: () => current };
}

describe("HR employee export — local ephemeral fallback", () => {
  afterEach(() => {
    hrExportEphemeralStore.clear();
  });

  it("create completes when object storage is unset and stores an ephemeral fileKey", async () => {
    const job = pendingJob();
    const { db, audit } = syncDb(job);
    const { membershipState, authContexts, access } = authStack();
    const files = {
      generateLocal: jest.fn().mockResolvedValue({
        tempPath: join(tmpdir(), `hr-export-test-${JOB_ID}.csv`),
        fileName: "employee-directory-2024-01-15-aaaaaaaa.csv",
        mimeType: "text/csv; charset=utf-8",
        fileSizeBytes: 42,
        rowCount: 3,
      }),
    };

    const service = new HrExportJobsService(
      db as never,
      { isConfigured: () => false } as never,
      audit as never,
      access as never,
      membershipState as never,
      authContexts as never,
      files as never,
    );

    const view = await service.create(actor(), FILTERS, "all", KEY);

    expect(view.status).toBe("completed");
    expect(view.rowCount).toBe(3);
    expect(view.fileName).toBe("employee-directory-2024-01-15-aaaaaaaa.csv");
    expect(files.generateLocal).toHaveBeenCalledTimes(1);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_export.completed" }),
    );
    expect(hrExportEphemeralStore.get(ORG, JOB_ID)).toEqual(
      expect.objectContaining({
        tempPath: join(tmpdir(), `hr-export-test-${JOB_ID}.csv`),
        fileSizeBytes: 42,
      }),
    );
  });

  it("getDownload serves a Readable stream from the ephemeral store", async () => {
    const tempPath = join(tmpdir(), `hr-export-dl-${JOB_ID}.csv`);
    writeFileSync(tempPath, "Name,Email\nAda,ada@example.com\n", { mode: 0o600 });
    hrExportEphemeralStore.put(ORG, JOB_ID, {
      tempPath,
      mimeType: "text/csv; charset=utf-8",
      fileSizeBytes: 32,
    });

    const completed = pendingJob({
      status: "completed",
      fileKey: ephemeralFileKey(JOB_ID),
      fileName: "employee-directory-2024-01-15-aaaaaaaa.csv",
      mimeType: "text/csv; charset=utf-8",
      fileSizeBytes: 32,
      rowCount: 1,
      processedRows: 1,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      limit: async () => [completed],
    };
    const { membershipState, authContexts, access } = authStack();
    const storage = {
      isConfigured: () => false,
      getFileStream: jest.fn(),
    };

    const service = new HrExportJobsService(
      { select: () => selectChain } as never,
      storage as never,
      { logCritical: jest.fn() } as never,
      access as never,
      membershipState as never,
      authContexts as never,
      {} as never,
    );

    const { file, job } = await service.getDownload(ORG, USER, JOB_ID);

    expect(job.status).toBe("completed");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(file.contentLength).toBe(32);
    expect(storage.getFileStream).not.toHaveBeenCalled();

    const chunks: Buffer[] = [];
    for await (const chunk of file.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("Ada");

    unlinkSync(tempPath);
  });

  it("getDownload returns Gone when the ephemeral artifact is missing", async () => {
    const completed = pendingJob({
      status: "completed",
      fileKey: ephemeralFileKey(JOB_ID),
      fileName: "gone.csv",
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      limit: async () => [completed],
    };
    const { membershipState, authContexts, access } = authStack();

    const service = new HrExportJobsService(
      { select: () => selectChain } as never,
      { isConfigured: () => false } as never,
      { logCritical: jest.fn() } as never,
      access as never,
      membershipState as never,
      authContexts as never,
      {} as never,
    );

    await expect(service.getDownload(ORG, USER, JOB_ID)).rejects.toBeInstanceOf(
      GoneException,
    );
  });
});
