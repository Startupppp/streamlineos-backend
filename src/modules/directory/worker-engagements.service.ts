import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { assertActiveOrgUnit } from "../../common/org/sync-org-unit-placement";
import { AuditService } from "../../common/audit/audit.service";
import { isUniqueViolation } from "../../common/db/postgres-error";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  organizationPeople,
  workerEngagements,
  workers,
} from "../../db/schema/directory";
import { hrJobLevels, hrJobRoles } from "../../db/schema/hr/core-org";
import type {
  CreateEngagementInput,
  CreateWorkerInput,
  ListWorkersQuery,
  TerminateEngagementInput,
  UpdateEngagementInput,
} from "./dto/directory.schemas";
import { DirectoryPersonEnsureService } from "./directory-person-ensure.service";
import {
  assertValidEngagementPeriod,
  ENGAGEMENT_ERROR,
  throwEngagementWriteError,
} from "./worker-engagement-errors";

const WORKER_SEARCH_CAP = 500;

type PersonRow = typeof organizationPeople.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;
type EngagementRow = typeof workerEngagements.$inferSelect;
type EngagementPatch = Partial<typeof workerEngagements.$inferInsert>;

@Injectable()
export class WorkerEngagementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly identities: DirectoryPersonEnsureService,
  ) {}

  private async loadPerson(organizationId: string, organizationPersonId: string): Promise<PersonRow> {
    const [row] = await this.db
      .select()
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationPersonId, organizationPersonId),
          eq(organizationPeople.organizationId, organizationId),
          isNull(organizationPeople.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Person not found");
    return row;
  }

  private async loadWorker(organizationId: string, workerId: string): Promise<WorkerRow> {
    const [row] = await this.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.workerId, workerId),
          eq(workers.organizationId, organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Worker not found");
    return row;
  }

  private async loadEngagement(
    organizationId: string,
    workerEngagementId: string,
  ): Promise<EngagementRow> {
    const [row] = await this.db
      .select()
      .from(workerEngagements)
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
          isNull(workerEngagements.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Engagement not found");
    return row;
  }

  private async resolveWorkerSearchCondition(search: string): Promise<SQL<unknown>> {
    const workerNumberClause = ilike(workers.workerNumber, `%${search}%`);
    const personFallback = or(
      ilike(organizationPeople.firstName, `%${search}%`),
      ilike(organizationPeople.lastName, `%${search}%`),
      ilike(organizationPeople.displayName, `%${search}%`),
      ilike(organizationPeople.workEmail, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_organization_people_ids(${search}, ${WORKER_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > WORKER_SEARCH_CAP) return or(personFallback, workerNumberClause)!;
    if (rows.length === 0) return workerNumberClause;
    const ids = rows.map((r) => String(r["id"]));
    return or(inArray(workers.organizationPersonId, ids), workerNumberClause)!;
  }

  async listWorkers(organizationId: string, query: ListWorkersQuery) {
    const { cursor, limit, status, search, organizationPersonId } = query;
    const searchCondition = search
      ? await this.resolveWorkerSearchCondition(search)
      : undefined;
    const conditions = and(
      eq(workers.organizationId, organizationId),
      isNull(workers.deletedAt),
      cursor ? gt(workers.workerId, cursor) : undefined,
      status ? eq(workers.status, status) : undefined,
      organizationPersonId ? eq(workers.organizationPersonId, organizationPersonId) : undefined,
      searchCondition,
    );
    const personJoin = and(
      eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
      eq(workers.organizationId, organizationPeople.organizationId),
    );
    const rows = await this.db
        .select({
          workerId: workers.workerId,
          organizationId: workers.organizationId,
          organizationPersonId: workers.organizationPersonId,
          workerNumber: workers.workerNumber,
          status: workers.status,
          isPayee: workers.isPayee,
          deletedAt: workers.deletedAt,
          createdAt: workers.createdAt,
          updatedAt: workers.updatedAt,
          firstName: organizationPeople.firstName,
          lastName: organizationPeople.lastName,
          displayName: organizationPeople.displayName,
          workEmail: organizationPeople.workEmail,
          avatarUrl: organizationPeople.avatarUrl,
          userId: organizationPeople.userId,
        })
        .from(workers)
        .innerJoin(organizationPeople, personJoin)
        .where(conditions)
        .orderBy(asc(workers.workerId))
        .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      data: pageRows,
      pageInfo: {
        limit,
        hasMore,
        nextCursor: hasMore ? (pageRows.at(-1)?.workerId ?? null) : null,
      },
    };
  }

  getWorker(organizationId: string, workerId: string) {
    return this.loadWorker(organizationId, workerId);
  }

  async createWorker(organizationId: string, userId: string, input: CreateWorkerInput) {
    let person: PersonRow;
    if (input.organizationPersonId) {
      person = await this.loadPerson(organizationId, input.organizationPersonId);
    } else if (input.memberUserId) {
      person = await this.identities.ensurePersonForMember(organizationId, input.memberUserId);
    } else {
      throw new BadRequestException("Select a directory person or an organization member.");
    }
    const [row] = await this.db
      .insert(workers)
      .values({
        organizationId,
        organizationPersonId: person.organizationPersonId,
        workerNumber: input.workerNumber ?? null,
        isPayee: input.isPayee ?? false,
      })
      .returning()
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictException("This person is already a worker in this organization.");
        }
        throw error;
      });
    if (!row) throw new NotFoundException("Failed to create worker");
    await this.audit.logCritical({
      action: "directory.worker.created",
      userId,
      orgId: organizationId,
      resourceType: "worker",
      resourceId: row.workerId,
      metadata: { workerId: row.workerId, organizationPersonId: row.organizationPersonId },
    });
    return row;
  }

  async listEngagements(organizationId: string, workerId: string) {
    await this.loadWorker(organizationId, workerId);
    return this.db
      .select()
      .from(workerEngagements)
      .where(
        and(
          eq(workerEngagements.organizationId, organizationId),
          eq(workerEngagements.workerId, workerId),
          isNull(workerEngagements.archivedAt),
        ),
      );
  }

  async createEngagement(
    organizationId: string,
    userId: string,
    membershipId: number | null,
    input: CreateEngagementInput,
  ) {
    await this.loadWorker(organizationId, input.workerId);
    assertValidEngagementPeriod(input.startsOn, input.endsOn);
    const [row] = await this.db
      .insert(workerEngagements)
      .values({
        organizationId,
        workerId: input.workerId,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        workerType: input.workerType,
        status: input.isPrimary ? "ACTIVE" : "PLANNED",
        isPrimary: input.isPrimary ?? false,
        designation: input.designation ?? null,
        createdByMembershipId: membershipId ?? null,
      })
      .returning()
      .catch(throwEngagementWriteError);
    if (!row) throw new NotFoundException("Failed to create engagement");
    await this.audit.logCritical({
      action: "directory.engagement.created",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: row.workerEngagementId,
      metadata: { workerEngagementId: row.workerEngagementId, workerId: row.workerId },
    });
    return row;
  }

  private async assertUpdateReferences(
    organizationId: string,
    workerEngagementId: string,
    workerId: string,
    input: UpdateEngagementInput,
  ): Promise<void> {
    const unitChecks = [
      ["BUSINESS_UNIT", input.businessUnitId],
      ["BRANCH", input.branchId],
      ["DEPARTMENT", input.departmentId],
      ["TEAM", input.teamId],
      ["LOCATION", input.locationId],
    ] as const;
    await Promise.all(
      unitChecks.map(([unitKind, orgUnitId]) =>
        orgUnitId === undefined || orgUnitId === null
          ? Promise.resolve()
          : assertActiveOrgUnit(this.db, organizationId, orgUnitId, unitKind),
      ),
    );

    if (input.employmentTypeId !== undefined && input.employmentTypeId !== null) {
      throw new BadRequestException(
        "Employment type IDs are not supported by the current catalog. Use workerType instead.",
      );
    }
    if (input.managerEngagementId !== undefined && input.managerEngagementId !== null) {
      if (input.managerEngagementId === workerEngagementId) {
        throw new BadRequestException("An engagement cannot manage itself.");
      }
      const [manager] = await this.db
        .select({ workerId: workerEngagements.workerId })
        .from(workerEngagements)
        .where(
          and(
            eq(workerEngagements.organizationId, organizationId),
            eq(workerEngagements.workerEngagementId, input.managerEngagementId),
            eq(workerEngagements.status, "ACTIVE"),
            isNull(workerEngagements.archivedAt),
          ),
        )
        .limit(1);
      if (!manager || manager.workerId === workerId) {
        throw new BadRequestException("Invalid manager engagement selection.");
      }
    }
    if (input.jobRoleId !== undefined && input.jobRoleId !== null) {
      const [role] = await this.db
        .select({ id: hrJobRoles.id })
        .from(hrJobRoles)
        .where(
          and(
            eq(hrJobRoles.id, input.jobRoleId),
            eq(hrJobRoles.orgId, organizationId),
            eq(hrJobRoles.isActive, true),
          ),
        )
        .limit(1);
      if (!role) throw new BadRequestException("Invalid job role selection.");
    }
    if (input.jobLevelId !== undefined && input.jobLevelId !== null) {
      const [level] = await this.db
        .select({ id: hrJobLevels.id })
        .from(hrJobLevels)
        .where(
          and(
            eq(hrJobLevels.id, input.jobLevelId),
            eq(hrJobLevels.orgId, organizationId),
            eq(hrJobLevels.isActive, true),
          ),
        )
        .limit(1);
      if (!level) throw new BadRequestException("Invalid job level selection.");
    }
  }

  async updateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: UpdateEngagementInput,
  ) {
    const existing = await this.loadEngagement(organizationId, workerEngagementId);
    assertValidEngagementPeriod(
      input.startsOn ?? existing.startsOn,
      input.endsOn === undefined ? existing.endsOn : input.endsOn,
    );
    await this.assertUpdateReferences(
      organizationId,
      workerEngagementId,
      existing.workerId,
      input,
    );

    const patch: EngagementPatch = {};
    if (input.startsOn !== undefined) patch.startsOn = input.startsOn;
    if (input.endsOn !== undefined) patch.endsOn = input.endsOn ?? null;
    if (input.workerType !== undefined) patch.workerType = input.workerType;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;
    if (input.designation !== undefined) patch.designation = input.designation ?? null;
    if (input.departmentId !== undefined) patch.departmentId = input.departmentId ?? null;
    if (input.businessUnitId !== undefined) patch.businessUnitId = input.businessUnitId ?? null;
    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
    if (input.locationId !== undefined) patch.locationId = input.locationId ?? null;
    if (input.teamId !== undefined) patch.teamId = input.teamId ?? null;
    if (input.managerEngagementId !== undefined) {
      patch.managerEngagementId = input.managerEngagementId ?? null;
    }
    if (input.jobRoleId !== undefined) patch.jobRoleId = input.jobRoleId ?? null;
    if (input.jobLevelId !== undefined) patch.jobLevelId = input.jobLevelId ?? null;
    if (input.employmentTypeId !== undefined) {
      patch.employmentTypeId = input.employmentTypeId ?? null;
    }
    if (input.probationEndsOn !== undefined) patch.probationEndsOn = input.probationEndsOn ?? null;
    if (input.noticePeriodDays !== undefined) patch.noticePeriodDays = input.noticePeriodDays ?? null;
    const [updated] = await this.db
      .update(workerEngagements)
      .set({
        ...patch,
        rowVersion: sql`${workerEngagements.rowVersion} + 1`,
      })
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
          eq(workerEngagements.rowVersion, input.expectedVersion),
        ),
      )
      .returning()
      .catch(throwEngagementWriteError);
    if (!updated) {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.STALE,
        message: "This engagement changed while you were viewing it. Refresh and try again.",
      });
    }
    await this.audit.logCritical({
      action: "directory.engagement.updated",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: workerEngagementId,
      metadata: { workerEngagementId },
    });
    return updated;
  }

  async cancelEngagement(organizationId: string, userId: string, workerEngagementId: string) {
    const existing = await this.loadEngagement(organizationId, workerEngagementId);
    if (existing.status === "CANCELLED") return existing;
    if (existing.status !== "PLANNED") {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.NOT_PLANNED,
        message: "Only a planned engagement can be cancelled. End an active engagement instead.",
      });
    }
    const [updated] = await this.db
      .update(workerEngagements)
      .set({ status: "CANCELLED", isPrimary: false })
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
          eq(workerEngagements.status, "PLANNED"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.NOT_PLANNED,
        message: "This engagement changed while you were viewing it. Refresh and try again.",
      });
    }
    await this.audit.logCritical({
      action: "directory.engagement.cancelled",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: workerEngagementId,
      metadata: { workerEngagementId },
    });
    return updated;
  }

  async terminateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: TerminateEngagementInput,
  ) {
    const existing = await this.loadEngagement(organizationId, workerEngagementId);
    if (existing.status !== "ACTIVE") {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.NOT_ACTIVE,
        message: "Only an active engagement can be terminated.",
      });
    }
    assertValidEngagementPeriod(existing.startsOn, input.endsOn ?? existing.endsOn);
    const [updated] = await this.db
      .update(workerEngagements)
      .set({
        status: "TERMINATED",
        endsOn: input.endsOn ?? existing.endsOn,
        terminationReason: input.terminationReason ?? null,
        terminationNotes: input.terminationNotes ?? null,
        isPrimary: false,
        rowVersion: sql`${workerEngagements.rowVersion} + 1`,
      })
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
          eq(workerEngagements.status, "ACTIVE"),
          eq(workerEngagements.rowVersion, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.STALE,
        message: "This engagement changed while you were viewing it. Refresh and try again.",
      });
    }
    await this.audit.logCritical({
      action: "directory.engagement.terminated",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: workerEngagementId,
      metadata: { workerEngagementId, terminationReason: input.terminationReason },
    });
    return updated;
  }
}
