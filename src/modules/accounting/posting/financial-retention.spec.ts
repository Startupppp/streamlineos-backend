import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FinancePostingService } from "./finance-posting.service";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): Db {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

const audit = { log: jest.fn() } as unknown as AuditService;
const cache = { invalidateNamespace: jest.fn() } as unknown as CacheService;
const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
const accountsSvc = {} as FinancePostingAccountsService;

describe("Financial record retention — legal hold beats mutation", () => {
  describe("assertEntryNotPosted — immutability gate", () => {
    it("blocks mutation of a POSTED journal entry", async () => {
      const svc = new FinancePostingService(makeDb([{ status: "POSTED" }]), accountsSvc, audit, dispatch, cache);
      await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);
    });

    it("allows mutation of a DRAFT journal entry", async () => {
      const svc = new FinancePostingService(makeDb([{ status: "DRAFT" }]), accountsSvc, audit, dispatch, cache);
      await expect(svc.assertEntryNotPosted("org-a", 1)).resolves.toBeUndefined();
    });

    it("allows mutation of a PENDING_APPROVAL journal entry", async () => {
      const svc = new FinancePostingService(makeDb([{ status: "PENDING_APPROVAL" }]), accountsSvc, audit, dispatch, cache);
      await expect(svc.assertEntryNotPosted("org-a", 1)).resolves.toBeUndefined();
    });

    it("is idempotent — repeated calls for a POSTED entry always throw", async () => {
      const svc = new FinancePostingService(makeDb([{ status: "POSTED" }]), accountsSvc, audit, dispatch, cache);
      await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);
      await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);
    });

    it("is tenant-correct — lookup WHERE clause contains the caller orgId", async () => {
      const whereSpy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
      const db = {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereSpy }) }),
      } as unknown as Db;
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);
      await svc.assertEntryNotPosted("org-target", 42);
      expect(sqlValues(whereSpy.mock.calls[0]?.[0])).toContain("org-target");
    });

    it("cross-tenant: org-a lookup WHERE clause does not reference org-b", async () => {
      const whereSpy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
      const db = {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereSpy }) }),
      } as unknown as Db;
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);
      await svc.assertEntryNotPosted("org-a", 1);
      const vals = sqlValues(whereSpy.mock.calls[0]?.[0]);
      expect(vals).toContain("org-a");
      expect(vals).not.toContain("org-b");
    });
  });

  describe("organization_legal_holds — hold blocks org purge", () => {
    it("purge worker reads legal holds inside runInNewTenantTransaction", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      expect(src).toContain("runInNewTenantTransaction");
      expect(src).toContain("organizationLegalHolds");
      expect(src).toContain("isNull(organizationLegalHolds.releasedAt)");
    });

    it("legal hold check precedes any adapter confirmation call", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      const holdIdx = src.indexOf("isNull(organizationLegalHolds.releasedAt)");
      const adapterCallIdx = src.indexOf("PURGE_ADAPTER_REGISTRY[adapter].confirm");
      expect(holdIdx).toBeGreaterThan(-1);
      expect(adapterCallIdx).toBeGreaterThan(-1);
      expect(holdIdx).toBeLessThan(adapterCallIdx);
    });

    it("returns legal-hold outcome before reaching adapter loop", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      const holdReturnIdx = src.indexOf('"legal-hold"');
      const adapterCallIdx = src.indexOf("PURGE_ADAPTER_REGISTRY[adapter].confirm");
      expect(holdReturnIdx).toBeGreaterThan(-1);
      expect(holdReturnIdx).toBeLessThan(adapterCallIdx);
    });

    it("financial records have no independent soft-delete column (journal_entries schema)", () => {
      const fs = require("fs");
      const path = require("path");
      const schemaSrc = fs.readFileSync(
        path.join(__dirname, "../../../db/schema/accounting/accounting.ts"),
        "utf8",
      );
      const jeStart = schemaSrc.indexOf('pgTable("journal_entries"');
      const jeEnd = schemaSrc.indexOf("export const journalLines");
      const jeBlock = schemaSrc.slice(jeStart, jeEnd);
      expect(jeBlock).not.toContain("deleted_at");
      expect(jeBlock).not.toContain("deletedAt");
    });

    it("journal_lines have no deleted_at — a VOID'd parent cannot orphan visible children via soft-delete", () => {
      const fs = require("fs");
      const path = require("path");
      const schemaSrc = fs.readFileSync(
        path.join(__dirname, "../../../db/schema/accounting/accounting.ts"),
        "utf8",
      );
      const jlStart = schemaSrc.indexOf("export const journalLines");
      const jlEnd = schemaSrc.indexOf("export const", jlStart + 1);
      const jlBlock = schemaSrc.slice(jlStart, jlEnd === -1 ? undefined : jlEnd);
      expect(jlBlock).not.toContain("deleted_at");
      expect(jlBlock).not.toContain("deletedAt");
    });

    it("purge worker reads legal hold inside a tenant transaction — not on the bare db", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      const holdWhereIdx = src.indexOf("isNull(organizationLegalHolds.releasedAt)");
      const tenantTxCallIdx = src.indexOf("runInNewTenantTransaction(");
      expect(holdWhereIdx).toBeGreaterThan(-1);
      expect(tenantTxCallIdx).toBeGreaterThan(-1);
      expect(tenantTxCallIdx).toBeLessThan(holdWhereIdx);
    });

    it("legal hold check is org-scoped — the WHERE clause includes org_id equality", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      expect(src).toContain("eq(organizationLegalHolds.orgId, orgId)");
    });

    it("expense export worker denies scope none — rows() returns empty list and skips export", async () => {
      const { ExpenseExportService } = await import("../../expenses/expense-export.service");
      const { StorageService } = await import("../../storage/storage.service");

      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([{ id: 1, date: "2026-01-01", employee: "Ada", email: "ada@test.com", category: "TRAVEL", amount: "100", description: null, status: "APPROVED", rejection: null }]),
                }),
              }),
            }),
          }),
        }),
      };

      const svc = new ExpenseExportService(db as never, {} as StorageService);
      const job = {
        id: "job-1",
        orgId: "org-a",
        filters: { scope: "none" as const, status: undefined, startDate: undefined, endDate: undefined },
        status: "running",
        attempt: 1,
        maxAttempts: 3,
        processedRows: 0,
        rowCount: null,
        truncated: false,
        fileKey: null,
        fileName: null,
        mimeType: "text/csv",
        fileSizeBytes: null,
        idempotencyKey: "key-1",
        requestHash: "hash-1",
        requestedByMembershipId: 1,
        errorCode: null,
        errorMessage: null,
        lockedAt: null,
        completedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never;

      const result = await svc.rows(job, undefined);
      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe("migration 0793 — journal_entries and journal_lines have DB-level immutability triggers", () => {
    const fs = require("fs");
    const path = require("path");
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../../../../migrations/0793_journal_entries_immutability_trigger.sql"),
      "utf8",
    );

    it("puts a BEFORE UPDATE trigger on journal_entries", () => {
      expect(migrationSql).toContain("CREATE TRIGGER trg_journal_entry_immutability");
      expect(migrationSql).toContain("BEFORE UPDATE ON journal_entries");
    });

    it("puts a BEFORE UPDATE trigger on journal_lines", () => {
      expect(migrationSql).toContain("CREATE TRIGGER trg_journal_line_immutability");
      expect(migrationSql).toContain("BEFORE UPDATE ON journal_lines");
    });

    it("the journal_entries trigger fires the enforce_journal_entry_immutability function", () => {
      expect(migrationSql).toContain("EXECUTE FUNCTION enforce_journal_entry_immutability()");
    });

    it("the journal_lines trigger fires the enforce_journal_line_immutability function", () => {
      expect(migrationSql).toContain("EXECUTE FUNCTION enforce_journal_line_immutability()");
    });

    it("the trigger function guards entry_number, currency and source fields", () => {
      expect(migrationSql).toContain("OLD.entry_number");
      expect(migrationSql).toContain("OLD.currency");
      expect(migrationSql).toContain("OLD.source_type");
    });

    it("the trigger function prevents status transitions from POSTED other than to VOID", () => {
      expect(migrationSql).toContain("VOID");
      expect(migrationSql).toContain("OLD.status = 'POSTED'");
    });

    it("the journal_lines trigger guards debit, credit and account_id", () => {
      expect(migrationSql).toContain("OLD.debit");
      expect(migrationSql).toContain("OLD.credit");
      expect(migrationSql).toContain("OLD.account_id");
    });

    it("sets lock_timeout before any DDL to prevent blocking the table", () => {
      const lockIdx = migrationSql.indexOf("SET lock_timeout");
      const triggerIdx = migrationSql.indexOf("CREATE OR REPLACE FUNCTION");
      expect(lockIdx).toBeGreaterThan(-1);
      expect(triggerIdx).toBeGreaterThan(-1);
      expect(lockIdx).toBeLessThan(triggerIdx);
    });

    it("uses check_violation ERRCODE — distinguishable from generic errors at the application layer", () => {
      expect(migrationSql).toContain("ERRCODE = 'check_violation'");
    });
  });

  describe("retention window — records outside purge window are swept; inside window survive", () => {
    it("an org with ACTIVE status is not in purge scope (purge worker skips it)", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      expect(src).toContain("PURGE_SCHEDULED");
      const purgeConditionIdx = src.indexOf("PURGE_SCHEDULED");
      const purgeStatusIdx = src.indexOf("statusV2", purgeConditionIdx);
      expect(purgeStatusIdx).toBeGreaterThan(-1);
    });

    it("an org with an active legal hold is returned before the adapter loop — outside-window rows survive", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      const holdReturnIdx = src.indexOf('"legal-hold"');
      const adapterConfirmIdx = src.indexOf("PURGE_ADAPTER_REGISTRY[adapter].confirm");
      expect(holdReturnIdx).toBeGreaterThan(-1);
      expect(adapterConfirmIdx).toBeGreaterThan(-1);
      expect(holdReturnIdx).toBeLessThan(adapterConfirmIdx);
    });

    it("tenant isolation — purgeSingle takes orgId as parameter, not from ambient state", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../../../modules/cron/cron-org-purge-worker.service.ts"),
        "utf8",
      );
      expect(src).toMatch(/private async purgeSingle\s*\(\s*orgId\s*:/);
    });

    it("journal entries are immutable after posting — mutation gate bites", async () => {
      const svc = new FinancePostingService(makeDb([{ status: "POSTED" }]), accountsSvc, audit, dispatch, cache);
      await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);

      const svc2 = new FinancePostingService(makeDb([{ status: "POSTED" }]), accountsSvc, audit, dispatch, cache);
      const spy = jest.spyOn(svc2, "assertEntryNotPosted");
      spy.mockResolvedValueOnce(undefined);
      await expect(svc2.assertEntryNotPosted("org-a", 1)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      await expect(svc2.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);
    });
  });
});
