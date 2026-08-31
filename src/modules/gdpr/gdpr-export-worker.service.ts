import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  auditLogs,
  hrDataRequests,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { forEachOrg } from "../../common/tenant";
import { GdprExportService, type GdprExportJobRow } from "./gdpr-export.service";

const BATCH_SIZE = 200;
const ROW_CAP_PER_SECTION = 5_000;

interface ExportSection {
  rows: unknown[];
  truncated: boolean;
}

@Injectable()
export class GdprExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GdprExportWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: GdprExportService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.GDPR_EXPORT_WORKER_ENABLED !== "false") {
      this.timer = setInterval(() => void this.tick(), 30_000);
      this.timer.unref();
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  wake() {
    void this.tick();
  }

  private async tick() {
    if (this.running || !this.storage.isConfigured()) return;
    this.running = true;
    try {
      await forEachOrg(this.db, "gdpr-export-worker", async (_tx, orgId) => {
        const job = await this.jobs.claim(orgId);
        if (job) await this.process(job);
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async process(job: GdprExportJobRow) {
    try {
      const memberships = await this.fetchSection(
        (afterId) => this.fetchMemberships(job.orgId, job.subjectUserId, afterId),
      );
      const employment = await this.fetchSection(
        (afterId) => this.fetchEmployment(job.orgId, job.subjectUserId, afterId),
      );
      const dataRequests = await this.fetchSection(
        (afterId) => this.fetchDataRequests(job.orgId, job.subjectUserId, afterId),
      );
      const legalHolds = await this.fetchSection(
        (afterId) => this.fetchLegalHolds(job.orgId, job.subjectUserId, afterId),
      );

      const auditEntriesPresent = await this.checkAuditEntries(job.orgId, job.subjectUserId);

      const totalRows =
        memberships.rows.length +
        employment.rows.length +
        dataRequests.rows.length +
        legalHolds.rows.length;

      const truncated =
        memberships.truncated ||
        employment.truncated ||
        dataRequests.truncated ||
        legalHolds.truncated;

      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        subjectUserId: job.subjectUserId,
        sections: {
          memberships: memberships.rows,
          employment: employment.rows,
          dataRequests: dataRequests.rows,
          legalHolds: legalHolds.rows,
        },
        auditEntriesPresent,
        exportIncomplete: truncated
          ? ["One or more sections were truncated at the row cap. Request a full extract via support."]
          : [],
      });

      const result = await this.storage.uploadFile(
        job.orgId,
        Buffer.from(payload, "utf8"),
        "gdpr-exports",
        `gdpr-export-${job.id}.json`,
        "application/json",
      );

      await this.jobs.complete(
        job.id,
        result.key,
        `gdpr-export-${job.createdAt.toISOString().slice(0, 10)}.json`,
        result.size,
        totalRows,
        truncated,
      );
    } catch (error) {
      await this.jobs.fail(job, error);
    }
  }

  private async fetchSection(
    fetcher: (afterId: number | undefined) => Promise<Array<{ id: number } & Record<string, unknown>>>,
  ): Promise<ExportSection> {
    const rows: unknown[] = [];
    let afterId: number | undefined;
    let truncated = false;

    for (;;) {
      const batch = await fetcher(afterId);
      if (!batch.length) break;
      for (const row of batch) {
        rows.push(row);
        afterId = row.id;
        if (rows.length >= ROW_CAP_PER_SECTION) {
          truncated = true;
          break;
        }
      }
      if (truncated || batch.length < BATCH_SIZE) break;
    }

    return { rows, truncated };
  }

  private async fetchMemberships(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(organizationMembers.userId, subjectUserId),
      eq(organizationMembers.orgId, orgId),
    ];
    if (afterId !== undefined) conditions.push(gt(organizationMembers.id, afterId));
    return this.db
      .select({
        id: organizationMembers.id,
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        status: organizationMembers.status,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(and(...conditions))
      .orderBy(asc(organizationMembers.id))
      .limit(BATCH_SIZE);
  }

  private async fetchEmployment(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const personRows = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.userId, subjectUserId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
        ),
      );
    if (!personRows.length) return [];
    const personId = personRows[0]!.id;
    const conditions = [
      eq(hrEmployments.personId, personId),
      isNull(hrEmployments.deletedAt),
    ];
    if (afterId !== undefined) conditions.push(gt(hrEmployments.id, afterId));
    return this.db
      .select({
        id: hrEmployments.id,
        lifecycleStatus: hrEmployments.lifecycleStatus,
        departmentId: hrEmployments.departmentId,
        designation: hrEmployments.designation,
        joiningDate: hrEmployments.joiningDate,
        lastWorkingDay: hrEmployments.lastWorkingDay,
      })
      .from(hrEmployments)
      .where(and(...conditions))
      .orderBy(asc(hrEmployments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchDataRequests(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(hrDataRequests.subjectUserId, subjectUserId),
      eq(hrDataRequests.orgId, orgId),
      isNull(hrDataRequests.deletedAt),
    ];
    if (afterId !== undefined) conditions.push(gt(hrDataRequests.id, afterId));
    return this.db
      .select({
        id: hrDataRequests.id,
        orgId: hrDataRequests.orgId,
        type: hrDataRequests.type,
        status: hrDataRequests.status,
        reason: hrDataRequests.reason,
        createdAt: hrDataRequests.createdAt,
      })
      .from(hrDataRequests)
      .where(and(...conditions))
      .orderBy(asc(hrDataRequests.id))
      .limit(BATCH_SIZE);
  }

  private async fetchLegalHolds(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(hrLegalHolds.subjectUserId, subjectUserId),
      eq(hrLegalHolds.orgId, orgId),
      isNull(hrLegalHolds.deletedAt),
    ];
    if (afterId !== undefined) conditions.push(gt(hrLegalHolds.id, afterId));
    return this.db
      .select({
        id: hrLegalHolds.id,
        reason: hrLegalHolds.reason,
        status: hrLegalHolds.status,
        placedAt: hrLegalHolds.placedAt,
        releasedAt: hrLegalHolds.releasedAt,
      })
      .from(hrLegalHolds)
      .where(and(...conditions))
      .orderBy(asc(hrLegalHolds.id))
      .limit(BATCH_SIZE);
  }

  private async checkAuditEntries(orgId: string, subjectUserId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, subjectUserId), eq(auditLogs.orgId, orgId)))
      .limit(1);
    return Boolean(row);
  }
}
