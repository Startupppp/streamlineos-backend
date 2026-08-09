import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, ilike, isNull, or } from "drizzle-orm";
import {
  organizationPeople,
  workers,
  workerEngagements,
} from "../../db/schema/directory";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { getPostgresErrorCode } from "../../common/db/postgres-error";
import { DirectoryIdentityService } from "./directory-identity.service";
import type {
  CreatePersonInput,
  ListPeopleQuery,
  UpdatePersonInput,
  ListWorkersQuery,
  CreateWorkerInput,
  CreateEngagementInput,
  UpdateEngagementInput,
  TerminateEngagementInput,
} from "./dto/directory.schemas";

const PG_UNIQUE_VIOLATION = "23505";
const PG_EXCLUSION_VIOLATION = "23P01";

const ENGAGEMENT_ERROR = {
  DATE_OVERLAP: "WORKER_ENGAGEMENT_DATE_OVERLAP",
  PRIMARY_EXISTS: "WORKER_PRIMARY_ENGAGEMENT_EXISTS",
  INVALID_DATES: "WORKER_ENGAGEMENT_INVALID_DATES",
  NOT_PLANNED: "WORKER_ENGAGEMENT_NOT_PLANNED",
} as const;

function assertValidEngagementPeriod(
  startsOn: string,
  endsOn?: string | null,
): void {
  if (!endsOn || endsOn > startsOn) return;
  throw new BadRequestException({
    code: ENGAGEMENT_ERROR.INVALID_DATES,
    message: "End date must be after the start date.",
  });
}

function throwEngagementWriteError(error: unknown): never {
  const code = getPostgresErrorCode(error);
  if (code === PG_UNIQUE_VIOLATION) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.PRIMARY_EXISTS,
      message:
        "This worker already has an active primary engagement. Unmark Primary, or end the current primary engagement first.",
    });
  }
  if (code === PG_EXCLUSION_VIOLATION) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.DATE_OVERLAP,
      message:
        "These dates overlap an existing planned or active engagement. Change the dates, or cancel or end the existing engagement first.",
    });
  }
  throw error;
}

type PersonRow = typeof organizationPeople.$inferSelect;
type PersonPatch = Partial<typeof organizationPeople.$inferInsert>;
type WorkerRow = typeof workers.$inferSelect;
type EngagementRow = typeof workerEngagements.$inferSelect;
type EngagementPatch = Partial<typeof workerEngagements.$inferInsert>;

@Injectable()
export class DirectoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly identities: DirectoryIdentityService,
  ) {}

  private async loadPerson(
    organizationId: string,
    organizationPersonId: string,
  ): Promise<PersonRow> {
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

  async listPeople(organizationId: string, query: ListPeopleQuery) {
    const { page, limit, search } = query;
    const offset = (page - 1) * limit;

    const searchCondition = search
      ? or(
          ilike(organizationPeople.firstName, `%${search}%`),
          ilike(organizationPeople.lastName, `%${search}%`),
          ilike(organizationPeople.displayName, `%${search}%`),
          ilike(organizationPeople.workEmail, `%${search}%`),
        )
      : undefined;

    const conditions = and(
      eq(organizationPeople.organizationId, organizationId),
      isNull(organizationPeople.deletedAt),
      searchCondition,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(organizationPeople)
        .where(conditions)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationPeople)
        .where(conditions),
    ]);

    const total = Number(totalRow?.total ?? 0);
    return {
      data: await this.identities.resolvePeopleAccess(organizationId, rows),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getPerson(organizationId: string, organizationPersonId: string) {
    const person = await this.loadPerson(organizationId, organizationPersonId);
    return this.identities.resolvePersonAccess(organizationId, person);
  }

  async createPerson(
    organizationId: string,
    userId: string,
    input: CreatePersonInput,
  ) {
    const workEmail = input.workEmail?.trim().toLowerCase();
    const personalEmail = input.personalEmail?.trim().toLowerCase();
    const identity = await this.identities.resolveLinkForPersonWrite(
      organizationId,
      {
        memberUserId: input.userId,
        organizationMembershipId: input.organizationMembershipId,
        workEmail,
        personalEmail,
      },
    );
    const [row] = await this.db
      .insert(organizationPeople)
      .values({
        organizationId,
        firstName: input.firstName,
        lastName: input.lastName,
        workEmail: workEmail ?? null,
        personalEmail: personalEmail ?? null,
        phone: input.phone ?? null,
        userId: identity?.userId ?? null,
        organizationMembershipId: identity?.organizationMembershipId ?? null,
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException(
            "A person with this work email already exists in this organization.",
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create person");
    this.audit.log({
      action: "directory.person.created",
      userId,
      orgId: organizationId,
      resourceType: "organization_person",
      resourceId: row.organizationPersonId,
      metadata: {
        organizationPersonId: row.organizationPersonId,
        firstName: row.firstName,
        lastName: row.lastName,
      },
    });
    return this.identities.resolvePersonAccess(organizationId, row);
  }

  async updatePerson(
    organizationId: string,
    userId: string,
    organizationPersonId: string,
    input: UpdatePersonInput,
  ) {
    const existingPerson = await this.loadPerson(
      organizationId,
      organizationPersonId,
    );
    const proposedWorkEmail =
      input.workEmail === undefined
        ? existingPerson.workEmail
        : input.workEmail?.trim().toLowerCase() || null;
    const proposedPersonalEmail =
      input.personalEmail === undefined
        ? existingPerson.personalEmail
        : input.personalEmail?.trim().toLowerCase() || null;
    const identity = await this.identities.resolveLinkForPersonWrite(
      organizationId,
      {
        memberUserId:
          input.userId === undefined ? existingPerson.userId : input.userId,
        organizationMembershipId:
          input.organizationMembershipId === undefined
            ? existingPerson.organizationMembershipId
            : input.organizationMembershipId,
        workEmail: proposedWorkEmail,
        personalEmail: proposedPersonalEmail,
      },
      organizationPersonId,
    );

    const patch: PersonPatch = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName;
    if (input.displayName !== undefined)
      patch.displayName = input.displayName ?? null;
    if (input.preferredName !== undefined)
      patch.preferredName = input.preferredName ?? null;
    if (input.workEmail !== undefined) patch.workEmail = proposedWorkEmail;
    if (input.personalEmail !== undefined)
      patch.personalEmail = proposedPersonalEmail;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.whatsappNumber !== undefined)
      patch.whatsappNumber = input.whatsappNumber ?? null;
    if (input.avatarUrl !== undefined)
      patch.avatarUrl = input.avatarUrl ?? null;
    if (input.dateOfBirth !== undefined)
      patch.dateOfBirth = input.dateOfBirth ?? null;
    if (input.gender !== undefined) patch.gender = input.gender ?? null;
    if (input.nationality !== undefined)
      patch.nationality = input.nationality ?? null;
    if (input.timezone !== undefined) patch.timezone = input.timezone ?? null;
    if (input.languageCode !== undefined)
      patch.languageCode = input.languageCode ?? null;
    if (input.linkedinUrl !== undefined)
      patch.linkedinUrl = input.linkedinUrl ?? null;
    if (input.githubUrl !== undefined)
      patch.githubUrl = input.githubUrl ?? null;
    if (input.bio !== undefined) patch.bio = input.bio ?? null;
    if (identity) {
      patch.userId = identity.userId;
      patch.organizationMembershipId = identity.organizationMembershipId;
    } else {
      if (input.userId !== undefined) patch.userId = input.userId ?? null;
      if (input.organizationMembershipId !== undefined)
        patch.organizationMembershipId = input.organizationMembershipId ?? null;
    }

    const [updated] = await this.db
      .update(organizationPeople)
      .set(patch)
      .where(
        and(
          eq(organizationPeople.organizationPersonId, organizationPersonId),
          eq(organizationPeople.organizationId, organizationId),
        ),
      )
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException(
            "A person with this work email already exists in this organization.",
          );
        }
        throw err;
      });
    if (!updated) throw new NotFoundException("Person not found");
    this.audit.log({
      action: "directory.person.updated",
      userId,
      orgId: organizationId,
      resourceType: "organization_person",
      resourceId: organizationPersonId,
      metadata: { organizationPersonId },
    });
    return this.identities.resolvePersonAccess(organizationId, updated);
  }

  async softDeletePerson(
    organizationId: string,
    userId: string,
    organizationPersonId: string,
  ) {
    await this.loadPerson(organizationId, organizationPersonId);
    await this.db
      .update(organizationPeople)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(organizationPeople.organizationPersonId, organizationPersonId),
          eq(organizationPeople.organizationId, organizationId),
        ),
      );
    this.audit.log({
      action: "directory.person.deleted",
      userId,
      orgId: organizationId,
      resourceType: "organization_person",
      resourceId: organizationPersonId,
      metadata: { organizationPersonId },
    });
  }

  private async loadWorker(
    organizationId: string,
    workerId: string,
  ): Promise<WorkerRow> {
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
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Engagement not found");
    return row;
  }

  async listWorkers(organizationId: string, query: ListWorkersQuery) {
    const { page, limit, status, search, organizationPersonId } = query;
    const offset = (page - 1) * limit;

    const searchCondition = search
      ? or(
          ilike(organizationPeople.firstName, `%${search}%`),
          ilike(organizationPeople.lastName, `%${search}%`),
          ilike(organizationPeople.displayName, `%${search}%`),
          ilike(organizationPeople.workEmail, `%${search}%`),
          ilike(workers.workerNumber, `%${search}%`),
        )
      : undefined;

    const conditions = and(
      eq(workers.organizationId, organizationId),
      isNull(workers.deletedAt),
      status ? eq(workers.status, status) : undefined,
      organizationPersonId ? eq(workers.organizationPersonId, organizationPersonId) : undefined,
      searchCondition,
    );
    const personJoin = and(
      eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
      eq(workers.organizationId, organizationPeople.organizationId),
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
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
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(workers)
        .innerJoin(organizationPeople, personJoin)
        .where(conditions),
    ]);

    const total = Number(totalRow?.total ?? 0);
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getWorker(organizationId: string, workerId: string) {
    return this.loadWorker(organizationId, workerId);
  }

  async createWorker(
    organizationId: string,
    userId: string,
    input: CreateWorkerInput,
  ) {
    let person: PersonRow;
    if (input.organizationPersonId)
      person = await this.loadPerson(organizationId, input.organizationPersonId);
    else if (input.memberUserId)
      person = await this.identities.ensurePersonForMember(
        organizationId,
        input.memberUserId,
      );
    else
      throw new BadRequestException(
        "Select a directory person or an organization member.",
      );

    const [row] = await this.db
      .insert(workers)
      .values({
        organizationId,
        organizationPersonId: person.organizationPersonId,
        workerNumber: input.workerNumber ?? null,
        isPayee: input.isPayee ?? false,
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException(
            "This person is already a worker in this organization.",
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create worker");
    this.audit.log({
      action: "directory.worker.created",
      userId,
      orgId: organizationId,
      resourceType: "worker",
      resourceId: row.workerId,
      metadata: {
        workerId: row.workerId,
        organizationPersonId: row.organizationPersonId,
      },
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
        ),
      );
  }

  async createEngagement(
    organizationId: string,
    userId: string,
    input: CreateEngagementInput,
  ) {
    await this.loadWorker(organizationId, input.workerId);
    assertValidEngagementPeriod(input.startsOn, input.endsOn);

    const status = input.isPrimary ? "ACTIVE" : "PLANNED";

    const [row] = await this.db
      .insert(workerEngagements)
      .values({
        organizationId,
        workerId: input.workerId,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        workerType: input.workerType,
        status,
        isPrimary: input.isPrimary ?? false,
        designation: input.designation ?? null,
        createdBy: userId,
      })
      .returning()
      .catch(throwEngagementWriteError);
    if (!row) throw new NotFoundException("Failed to create engagement");
    this.audit.log({
      action: "directory.engagement.created",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: row.workerEngagementId,
      metadata: {
        workerEngagementId: row.workerEngagementId,
        workerId: row.workerId,
      },
    });
    return row;
  }

  async updateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: UpdateEngagementInput,
  ) {
    const existing = await this.loadEngagement(
      organizationId,
      workerEngagementId,
    );
    assertValidEngagementPeriod(
      input.startsOn ?? existing.startsOn,
      input.endsOn === undefined ? existing.endsOn : input.endsOn,
    );

    const patch: EngagementPatch = {};
    if (input.startsOn !== undefined) patch.startsOn = input.startsOn;
    if (input.endsOn !== undefined) patch.endsOn = input.endsOn ?? null;
    if (input.workerType !== undefined) patch.workerType = input.workerType;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;
    if (input.designation !== undefined)
      patch.designation = input.designation ?? null;
    if (input.departmentId !== undefined)
      patch.departmentId = input.departmentId ?? null;
    if (input.businessUnitId !== undefined)
      patch.businessUnitId = input.businessUnitId ?? null;
    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
    if (input.locationId !== undefined)
      patch.locationId = input.locationId ?? null;
    if (input.teamId !== undefined) patch.teamId = input.teamId ?? null;
    if (input.managerEngagementId !== undefined)
      patch.managerEngagementId = input.managerEngagementId ?? null;
    if (input.jobRoleId !== undefined)
      patch.jobRoleId = input.jobRoleId ?? null;
    if (input.jobLevelId !== undefined)
      patch.jobLevelId = input.jobLevelId ?? null;
    if (input.employmentTypeId !== undefined)
      patch.employmentTypeId = input.employmentTypeId ?? null;
    if (input.probationEndsOn !== undefined)
      patch.probationEndsOn = input.probationEndsOn ?? null;
    if (input.noticePeriodDays !== undefined)
      patch.noticePeriodDays = input.noticePeriodDays ?? null;

    const [updated] = await this.db
      .update(workerEngagements)
      .set(patch)
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
        ),
      )
      .returning()
      .catch(throwEngagementWriteError);
    if (!updated) throw new NotFoundException("Engagement not found");
    this.audit.log({
      action: "directory.engagement.updated",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: workerEngagementId,
      metadata: { workerEngagementId },
    });
    return updated;
  }

  async cancelEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
  ) {
    const existing = await this.loadEngagement(
      organizationId,
      workerEngagementId,
    );
    if (existing.status === "CANCELLED") return existing;
    if (existing.status !== "PLANNED") {
      throw new ConflictException({
        code: ENGAGEMENT_ERROR.NOT_PLANNED,
        message:
          "Only a planned engagement can be cancelled. End an active engagement instead.",
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
        message:
          "This engagement changed while you were viewing it. Refresh and try again.",
      });
    }
    this.audit.log({
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
    const existing = await this.loadEngagement(
      organizationId,
      workerEngagementId,
    );

    const [updated] = await this.db
      .update(workerEngagements)
      .set({
        status: "TERMINATED",
        endsOn: input.endsOn ?? existing.endsOn,
        terminationReason: input.terminationReason ?? null,
        terminationNotes: input.terminationNotes ?? null,
      })
      .where(
        and(
          eq(workerEngagements.workerEngagementId, workerEngagementId),
          eq(workerEngagements.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Engagement not found");
    this.audit.log({
      action: "directory.engagement.terminated",
      userId,
      orgId: organizationId,
      resourceType: "worker_engagement",
      resourceId: workerEngagementId,
      metadata: {
        workerEngagementId,
        terminationReason: input.terminationReason,
      },
    });
    return updated;
  }
}
