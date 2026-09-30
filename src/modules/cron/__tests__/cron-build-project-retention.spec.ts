jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as Record<string, unknown>).__buildRetentionTx, "org-1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import {
  projectRetentionSettings,
  tickets,
} from "../../../db/schema";
import { projectAttachments } from "../../../db/schema/build/project-attachments";
import { organizationLegalHolds } from "../../../db/schema/common/organization-purge";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import { StorageService } from "../../storage/storage.service";
import { StoragePendingPurgeService } from "../../storage/storage-pending-purge.service";
import {
  CronBuildProjectRetentionService,
  closedTicketPurgePredicate,
  decideBuildRetention,
  type BuildRetentionSettingsRow,
} from "../cron-build-project-retention.service";

const dialect = new PgDialect();

function sqlText(condition: SQL | null | undefined): string {
  if (!condition) return "";
  return dialect.sqlToQuery(condition).sql;
}

interface TxLog {
  selects: Array<{ table: unknown; where: SQL | null }>;
  inserts: Array<{ table: unknown; values: unknown }>;
  deletes: Array<{ table: unknown; where: SQL | null }>;
  operations: string[];
}

interface TxOptions {
  orgHold?: boolean;
  settings?: Array<Record<string, unknown>>;
  ticketBatches?: Array<Array<{ id: number }>>;
  attachmentBatches?: Array<Array<{ id: number; storageKey: string }>>;
  ticketCount?: number;
  attachmentCount?: number;
}

function makeTx(opts: TxOptions): TxLog {
  const log: TxLog = { selects: [], inserts: [], deletes: [], operations: [] };
  let ticketBatchIdx = 0;
  let attachmentBatchIdx = 0;
  let pendingPurgeIdx = 0;
  let settingsServed = false;

  function rowsFor(table: unknown, where: SQL | null): unknown[] {
    log.selects.push({ table, where });
    if (table === organizationLegalHolds) return opts.orgHold ? [{ holdId: "hold-1" }] : [];
    if (table === projectRetentionSettings) {
      if (settingsServed) return [];
      settingsServed = true;
      return opts.settings ?? [];
    }
    if (table === tickets) {
      if (opts.ticketBatches === undefined) return [{ pending: opts.ticketCount ?? 0 }];
      return opts.ticketBatches[ticketBatchIdx++] ?? [];
    }
    if (table === projectAttachments) {
      if (opts.attachmentBatches === undefined)
        return [{ pending: opts.attachmentCount ?? 0 }];
      return opts.attachmentBatches[attachmentBatchIdx++] ?? [];
    }
    if (table === storagePendingPurge)
      return [{ id: `pending-purge-${++pendingPurgeIdx}` }];
    return [];
  }

  const tx = {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        log.inserts.push({ table, values });
        log.operations.push("insert");
        const settled = Promise.resolve([]);
        return { onConflictDoUpdate: () => settled };
      },
    }),
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (where: SQL) => {
          const settle = () => Promise.resolve(rowsFor(table, where));
          return {
            limit: settle,
            orderBy: () => ({ limit: settle }),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (where: SQL) => {
        log.deletes.push({ table, where });
        log.operations.push("delete");
        return Promise.resolve([]);
      },
    }),
  };

  (globalThis as Record<string, unknown>).__buildRetentionTx = tx;
  return log;
}

function settingsRow(
  over: Partial<BuildRetentionSettingsRow> = {},
): Record<string, unknown> {
  return {
    id: 1,
    projectId: 7,
    inheritOrgPolicy: false,
    closedTicketRetentionDays: 30,
    attachmentRetentionDays: 30,
    legalHold: false,
    legalHoldReason: null,
    ...over,
  };
}

async function buildSvc(): Promise<{
  svc: CronBuildProjectRetentionService;
  audit: { logCriticalOutsideTransaction: jest.Mock };
  storage: { deleteFileIfPresent: jest.Mock };
  pendingPurge: { markConfirmed: jest.Mock; markFailed: jest.Mock };
}> {
  const audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined) };
  const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };
  const pendingPurge = {
    markConfirmed: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const mod = await Test.createTestingModule({
    providers: [
      CronBuildProjectRetentionService,
      { provide: DRIZZLE, useValue: {} },
      { provide: AuditService, useValue: audit },
      { provide: StorageService, useValue: storage },
      { provide: StoragePendingPurgeService, useValue: pendingPurge },
    ],
  }).compile();
  return { svc: mod.get(CronBuildProjectRetentionService), audit, storage, pendingPurge };
}

describe("build project retention — a project under legal hold is never purged", () => {
  it("skips a held project, counts it as held, and issues no delete", async () => {
    const log = makeTx({ settings: [settingsRow({ legalHold: true, legalHoldReason: "Acme v. Corp" })] });
    const { svc, audit } = await buildSvc();

    const result = await svc.sweep({ confirm: true });

    expect(result.projectsHeld).toBe(1);
    expect(result.projectsPurged).toBe(0);
    expect(log.deletes).toEqual([]);
    expect(audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
  });

  it("skips every project in an organization under an unreleased organization-wide hold", async () => {
    const log = makeTx({ orgHold: true, settings: [settingsRow()] });
    const { svc } = await buildSvc();

    const result = await svc.sweep({ confirm: true });

    expect(result.organizationsHeld).toBe(1);
    expect(result.projectsPurged).toBe(0);
    expect(log.deletes).toEqual([]);
  });

  it("decides legal_hold before it looks at any configured period", () => {
    const decision = decideBuildRetention(
      { ...settingsRow({ legalHold: true }) } as BuildRetentionSettingsRow,
      new Date("2026-09-29T00:00:00Z"),
    );
    expect(decision).toEqual({ projectId: 7, eligible: false, reason: "legal_hold" });
  });
});

describe("build project retention — an unconfigured period means keep forever", () => {
  it("skips a project whose retention days are both null", async () => {
    const log = makeTx({
      settings: [settingsRow({ closedTicketRetentionDays: null, attachmentRetentionDays: null })],
    });
    const { svc } = await buildSvc();

    const result = await svc.sweep({ confirm: true });

    expect(result.projectsUnconfigured).toBe(1);
    expect(result.projectsPurged).toBe(0);
    expect(log.deletes).toEqual([]);
  });

  it("skips a project that still inherits the org policy, because no org policy exists to inherit", async () => {
    const log = makeTx({ settings: [settingsRow({ inheritOrgPolicy: true })] });
    const { svc } = await buildSvc();

    const result = await svc.sweep({ confirm: true });

    expect(result.projectsUnconfigured).toBe(1);
    expect(log.deletes).toEqual([]);
  });

  it("purges only the entity whose own period is set", () => {
    const decision = decideBuildRetention(
      { ...settingsRow({ attachmentRetentionDays: null }) } as BuildRetentionSettingsRow,
      new Date("2026-09-29T00:00:00Z"),
    );
    expect(decision.eligible).toBe(true);
    if (!decision.eligible) throw new Error("unreachable");
    expect(decision.attachmentCutoff).toBeNull();
    expect(decision.ticketCutoff).toEqual(new Date("2026-08-30T00:00:00Z"));
  });

  it("treats a zero or negative period as unconfigured rather than as purge-everything", () => {
    for (const days of [0, -1]) {
      const decision = decideBuildRetention(
        {
          ...settingsRow({ closedTicketRetentionDays: days, attachmentRetentionDays: days }),
        } as BuildRetentionSettingsRow,
        new Date("2026-09-29T00:00:00Z"),
      );
      expect(decision).toEqual({ projectId: 7, eligible: false, reason: "no_configured_period" });
    }
  });
});

describe("build project retention — dry run is the default and destroys nothing", () => {
  it("reports what it would delete and issues no delete when the flag is absent", async () => {
    const log = makeTx({ settings: [settingsRow()], ticketCount: 4, attachmentCount: 2 });
    const { svc, audit } = await buildSvc();

    const result = await svc.sweep();

    expect(result.dryRun).toBe(true);
    expect(result.ticketsWouldDelete).toBe(4);
    expect(result.attachmentsWouldDelete).toBe(2);
    expect(result.ticketsDeleted).toBe(0);
    expect(result.attachmentsDeleted).toBe(0);
    expect(log.deletes).toEqual([]);
    expect(audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
  });

  it("treats any confirm value other than true as a dry run", async () => {
    const log = makeTx({ settings: [settingsRow()], ticketCount: 9 });
    const { svc } = await buildSvc();

    const result = await svc.sweep({ confirm: false });

    expect(result.dryRun).toBe(true);
    expect(log.deletes).toEqual([]);
  });

  it("deletes only when confirm is exactly true, and audits before each delete", async () => {
    const log = makeTx({
      settings: [settingsRow({ attachmentRetentionDays: null })],
      ticketBatches: [[{ id: 11 }, { id: 12 }]],
    });
    const { svc, audit } = await buildSvc();
    const order: string[] = [];
    audit.logCriticalOutsideTransaction.mockImplementation(async () => {
      order.push("audit");
    });

    const result = await svc.sweep({ confirm: true });

    expect(result.dryRun).toBe(false);
    expect(result.ticketsDeleted).toBe(2);
    expect(log.deletes).toHaveLength(1);
    expect(order).toEqual(["audit"]);
    expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledTimes(1);
    const entry = audit.logCriticalOutsideTransaction.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      action: "build.retention.purge",
      orgId: "org-1",
      systemActor: "build-project-retention",
      targetType: "project",
      targetId: "7",
      resourceType: "closed_tickets",
    });
    expect(entry.metadata).toMatchObject({ purgedCount: 2, purgedIds: [11, 12] });
  });

  it("writes the audit record on a transaction of its own, so a rolled-back purge still leaves the record", async () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "..", "cron-build-project-retention.service.ts"),
      "utf8",
    );
    expect(source).toContain("logCriticalOutsideTransaction");
    expect(source).not.toMatch(/this\.audit\.logCritical\(/);
  });
});

describe("build project retention — attachment objects use the pending-purge write-ahead ledger", () => {
  it("records the default-bucket key before deleting metadata, then confirms after object deletion", async () => {
    const log = makeTx({
      settings: [settingsRow({ closedTicketRetentionDays: null })],
      attachmentBatches: [[{ id: 21, storageKey: "org-1/build/7/files/report.pdf" }]],
    });
    const { svc, storage, pendingPurge } = await buildSvc();

    const result = await svc.sweep({ confirm: true });

    expect(result.attachmentsDeleted).toBe(1);
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0]?.table).toBe(storagePendingPurge);
    expect(log.inserts[0]?.values).toEqual([
      {
        orgId: "org-1",
        storageKey: "org-1/build/7/files/report.pdf",
        purpose: "build:project-attachment:retention",
        bucket: "default",
        status: "pending",
      },
    ]);
    expect(log.deletes).toHaveLength(1);
    expect(log.operations).toEqual(["insert", "delete"]);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(
      "org-1",
      "org-1/build/7/files/report.pdf",
      "default",
    );
    expect(pendingPurge.markConfirmed).toHaveBeenCalledWith(
      "org-1",
      "pending-purge-1",
    );
    expect(pendingPurge.markFailed).not.toHaveBeenCalled();
  });

  it("keeps a failed object delete retryable after the metadata row is removed", async () => {
    const log = makeTx({
      settings: [settingsRow({ closedTicketRetentionDays: null })],
      attachmentBatches: [[{ id: 22, storageKey: "org-1/build/7/files/fail.pdf" }]],
    });
    const { svc, storage, pendingPurge } = await buildSvc();
    storage.deleteFileIfPresent.mockRejectedValue(new Error("R2 unavailable"));

    await expect(svc.sweep({ confirm: true })).resolves.toMatchObject({ attachmentsDeleted: 1 });

    expect(log.inserts).toHaveLength(1);
    expect(log.deletes).toHaveLength(1);
    expect(pendingPurge.markFailed).toHaveBeenCalledWith(
      "org-1",
      "pending-purge-1",
      "Error: R2 unavailable",
    );
    expect(pendingPurge.markConfirmed).not.toHaveBeenCalled();
  });
});

describe("build project retention — only rows already soft-deleted past the window are selected", () => {
  it("requires deleted_at to be non-null and older than the cutoff", () => {
    const text = sqlText(closedTicketPurgePredicate("org-1", 7, new Date("2026-08-30T00:00:00Z")));
    expect(text).toContain('"deleted_at" is not null');
    expect(text).toContain('"deleted_at" < $');
    expect(text).not.toContain('"deleted_at" is null');
  });

  it("restricts the ticket purge to a status the project itself groups as completed", () => {
    const text = sqlText(closedTicketPurgePredicate("org-1", 7, new Date("2026-08-30T00:00:00Z")));
    expect(text).toContain("project_statuses");
    expect(text).toContain("EXISTS");
  });

  it("keys the cutoff off the configured window, so a row deleted inside it is outside the predicate", () => {
    const now = new Date("2026-09-29T00:00:00Z");
    const decision = decideBuildRetention(
      { ...settingsRow({ closedTicketRetentionDays: 365 }) } as BuildRetentionSettingsRow,
      now,
    );
    if (!decision.eligible) throw new Error("unreachable");
    const cutoff = decision.ticketCutoff;
    if (cutoff === null) throw new Error("unreachable");
    const deletedYesterday = new Date(now.getTime() - 86_400_000);
    const deletedTwoYearsAgo = new Date(now.getTime() - 730 * 86_400_000);
    expect(deletedYesterday.getTime() < cutoff.getTime()).toBe(false);
    expect(deletedTwoYearsAgo.getTime() < cutoff.getTime()).toBe(true);
  });

  it("scopes every purge to one organization and one project", () => {
    const text = sqlText(closedTicketPurgePredicate("org-1", 7, new Date("2026-08-30T00:00:00Z")));
    expect(text).toContain('"org_id" = $');
    expect(text).toContain('"project_id" = $');
  });
});
