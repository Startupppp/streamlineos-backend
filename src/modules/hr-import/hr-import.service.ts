import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  attendance,
  assets,
  leaveBalances,
  documents,
  users,
  organizationMembers,
  departments,
} from "../../db/schema";
import { hrImportJobs, hrImportRows } from "../../db/schema/hr/import-jobs";
import { HrAuditService } from "../hr-core/hr-audit.service";
import { HrImportCommitService } from "./hr-import-commit.service";
import { validateRows } from "./schemas/entity-row-schemas";
import type {
  CreateImportJobInput,
  ExportQueryInput,
  HrImportEntity,
  ListImportJobsInput,
} from "./dto/import-job.dto";

@Injectable()
export class HrImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly commitService: HrImportCommitService,
  ) {}

  async createJob(orgId: string, actorId: string, input: CreateImportJobInput) {
    const { entity, fileName, rows } = input;
    const { validRows, errorRows, topErrors } = validateRows(entity, rows);

    const [job] = await this.db
      .insert(hrImportJobs)
      .values({
        orgId,
        entity,
        fileName,
        status: "previewed",
        totalRows: rows.length,
        validRows: validRows.length,
        errorRows: errorRows.length,
        errors: topErrors,
        createdBy: actorId,
      })
      .returning();

    if (!job) throw new BadRequestException("Failed to create import job");

    const allResults = [
      ...validRows.map((r) => ({
        jobId: job.id,
        rowNumber: r.rowNumber,
        payload: r.payload,
        status: "valid" as const,
        error: null,
      })),
      ...errorRows.map((r) => ({
        jobId: job.id,
        rowNumber: r.rowNumber,
        payload: r.payload,
        status: "error" as const,
        error: r.error,
      })),
    ];

    if (allResults.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < allResults.length; i += BATCH) {
        await this.db.insert(hrImportRows).values(allResults.slice(i, i + BATCH));
      }
    }

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: job.id,
      action: "created",
      after: { entity, fileName, totalRows: rows.length, validRows: validRows.length, errorRows: errorRows.length },
    });

    return {
      job,
      summary: {
        total: rows.length,
        valid: validRows.length,
        errors: errorRows.length,
        topErrors,
      },
    };
  }

  async listJobs(orgId: string, input: ListImportJobsInput) {
    const { page, limit, entity } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrImportJobs.orgId, orgId)];
    if (entity) conditions.push(eq(hrImportJobs.entity, entity));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrImportJobs)
        .where(where)
        .orderBy(desc(hrImportJobs.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrImportJobs).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getJob(orgId: string, jobId: string) {
    const job = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    if (!job[0]) throw new NotFoundException("Import job not found");

    const errorRows = await this.db
      .select()
      .from(hrImportRows)
      .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "error")))
      .limit(50);

    return { job: job[0], errorRows };
  }

  async commitJob(orgId: string, actorId: string, jobId: string) {
    const existing = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    const job = existing[0];
    if (!job) throw new NotFoundException("Import job not found");
    if (job.status !== "previewed") {
      throw new BadRequestException(`Job cannot be committed in status '${job.status}'`);
    }

    await this.db.update(hrImportJobs).set({ status: "committing" }).where(eq(hrImportJobs.id, jobId));

    const validRows = await this.db
      .select()
      .from(hrImportRows)
      .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "valid")));

    let committed = 0;

    await this.db.transaction(async (tx) => {
      for (const row of validRows) {
        try {
          const ref = await this.commitService.commitRow(tx, orgId, job.entity as HrImportEntity, row.payload);
          if (ref) {
            await this.commitService.markRowCommitted(tx, row.id, ref);
            committed++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Commit failed";
          await tx
            .update(hrImportRows)
            .set({ status: "error", error: message })
            .where(eq(hrImportRows.id, row.id));
        }
      }

      await tx
        .update(hrImportJobs)
        .set({ status: "committed", committedAt: new Date(), validRows: committed })
        .where(eq(hrImportJobs.id, jobId));
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: jobId,
      action: "committed",
      after: { committed },
    });

    const updated = await this.db
      .select()
      .from(hrImportJobs)
      .where(eq(hrImportJobs.id, jobId))
      .limit(1);

    return updated[0];
  }

  async rollbackJob(orgId: string, actorId: string, jobId: string) {
    const existing = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    const job = existing[0];
    if (!job) throw new NotFoundException("Import job not found");
    if (job.status !== "committed") {
      throw new BadRequestException(`Job cannot be rolled back in status '${job.status}'`);
    }

    const committedRows = await this.db
      .select()
      .from(hrImportRows)
      .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "committed")));

    await this.db.transaction(async (tx) => {
      for (const row of committedRows) {
        if (row.createdRecordRef) {
          await this.commitService.rollbackRef(tx, row.createdRecordRef);
        }
      }

      await tx
        .update(hrImportJobs)
        .set({ status: "rolled_back", rolledBackAt: new Date() })
        .where(eq(hrImportJobs.id, jobId));
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: jobId,
      action: "rolled_back",
    });

    const updated = await this.db
      .select()
      .from(hrImportJobs)
      .where(eq(hrImportJobs.id, jobId))
      .limit(1);

    return updated[0];
  }

  async exportEntity(orgId: string, entity: HrImportEntity, input: ExportQueryInput) {
    const { page, limit } = input;
    const offset = (page - 1) * limit;

    if (entity === "employees") {
      return this.db
        .select({
          employeeId: users.employeeId,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          designation: users.designation,
          department: departments.name,
          role: users.role,
          joiningDate: users.joiningDate,
          isActive: users.isActive,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(departments, eq(departments.id, users.departmentId))
        .where(eq(organizationMembers.orgId, orgId))
        .limit(limit)
        .offset(offset);
    }
    if (entity === "attendance") {
      return this.db
        .select()
        .from(attendance)
        .where(eq(attendance.orgId, orgId))
        .limit(limit)
        .offset(offset);
    }
    if (entity === "assets") {
      return this.db
        .select()
        .from(assets)
        .where(eq(assets.orgId, orgId))
        .limit(limit)
        .offset(offset);
    }
    if (entity === "leave_balances") {
      return this.db
        .select()
        .from(leaveBalances)
        .where(eq(leaveBalances.orgId, orgId))
        .limit(limit)
        .offset(offset);
    }
    if (entity === "document_metadata") {
      return this.db
        .select()
        .from(documents)
        .where(and(eq(documents.orgId, orgId)))
        .limit(limit)
        .offset(offset);
    }
    return [];
  }
}
