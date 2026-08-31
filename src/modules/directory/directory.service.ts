import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { organizationPeople } from "../../db/schema/directory";
import type {
  CreateEngagementInput,
  CreatePersonInput,
  CreateWorkerInput,
  ListPeopleQuery,
  ListWorkersQuery,
  TerminateEngagementInput,
  UpdateEngagementInput,
  UpdatePersonInput,
} from "./dto/directory.schemas";
import { DirectoryIdentityService } from "./directory-identity.service";
import { WorkerEngagementsService } from "./worker-engagements.service";

const PG_UNIQUE_VIOLATION = "23505";
const DIRECTORY_SEARCH_CAP = 500;
type PersonRow = typeof organizationPeople.$inferSelect;
type PersonPatch = Partial<typeof organizationPeople.$inferInsert>;

@Injectable()
export class DirectoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly identities: DirectoryIdentityService,
    private readonly workerEngagements: WorkerEngagementsService,
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

  private async resolvePersonSearchCondition(search: string): Promise<SQL<unknown>> {
    const fallback = or(
      ilike(organizationPeople.firstName, `%${search}%`),
      ilike(organizationPeople.lastName, `%${search}%`),
      ilike(organizationPeople.displayName, `%${search}%`),
      ilike(organizationPeople.workEmail, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_organization_people_ids(${search}, ${DIRECTORY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > DIRECTORY_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => String(r["id"]));
    return inArray(organizationPeople.organizationPersonId, ids);
  }

  async listPeople(organizationId: string, query: ListPeopleQuery) {
    const { cursor, limit, search } = query;
    const searchCondition = search
      ? await this.resolvePersonSearchCondition(search)
      : undefined;
    const conditions = and(
      eq(organizationPeople.organizationId, organizationId),
      isNull(organizationPeople.deletedAt),
      cursor
        ? gt(organizationPeople.organizationPersonId, cursor)
        : undefined,
      searchCondition,
    );
    const rows = await this.db
      .select()
      .from(organizationPeople)
      .where(conditions)
      .orderBy(asc(organizationPeople.organizationPersonId))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      data: await this.identities.resolvePeopleAccess(organizationId, pageRows),
      pageInfo: {
        limit,
        hasMore,
        nextCursor: hasMore
          ? (pageRows.at(-1)?.organizationPersonId ?? null)
          : null,
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
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException(
            "A person with this work email already exists in this organization.",
          );
        }
        throw error;
      });
    if (!row) throw new NotFoundException("Failed to create person");
    await this.audit.logCritical({
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
    const existingPerson = await this.loadPerson(organizationId, organizationPersonId);
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
        memberUserId: input.userId === undefined ? existingPerson.userId : input.userId,
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
    if (input.displayName !== undefined) patch.displayName = input.displayName ?? null;
    if (input.preferredName !== undefined) patch.preferredName = input.preferredName ?? null;
    if (input.workEmail !== undefined) patch.workEmail = proposedWorkEmail;
    if (input.personalEmail !== undefined) patch.personalEmail = proposedPersonalEmail;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.whatsappNumber !== undefined) patch.whatsappNumber = input.whatsappNumber ?? null;
    if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl ?? null;
    if (input.dateOfBirth !== undefined) patch.dateOfBirth = input.dateOfBirth ?? null;
    if (input.gender !== undefined) patch.gender = input.gender ?? null;
    if (input.nationality !== undefined) patch.nationality = input.nationality ?? null;
    if (input.timezone !== undefined) patch.timezone = input.timezone ?? null;
    if (input.languageCode !== undefined) patch.languageCode = input.languageCode ?? null;
    if (input.linkedinUrl !== undefined) patch.linkedinUrl = input.linkedinUrl ?? null;
    if (input.githubUrl !== undefined) patch.githubUrl = input.githubUrl ?? null;
    if (input.bio !== undefined) patch.bio = input.bio ?? null;
    if (identity) {
      patch.userId = identity.userId;
      patch.organizationMembershipId = identity.organizationMembershipId;
    } else {
      if (input.userId !== undefined) patch.userId = input.userId ?? null;
      if (input.organizationMembershipId !== undefined) {
        patch.organizationMembershipId = input.organizationMembershipId ?? null;
      }
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
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException(
            "A person with this work email already exists in this organization.",
          );
        }
        throw error;
      });
    if (!updated) throw new NotFoundException("Person not found");
    await this.audit.logCritical({
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
    await this.audit.logCritical({
      action: "directory.person.deleted",
      userId,
      orgId: organizationId,
      resourceType: "organization_person",
      resourceId: organizationPersonId,
      metadata: { organizationPersonId },
    });
  }

  listWorkers(organizationId: string, query: ListWorkersQuery) {
    return this.workerEngagements.listWorkers(organizationId, query);
  }

  getWorker(organizationId: string, workerId: string) {
    return this.workerEngagements.getWorker(organizationId, workerId);
  }

  createWorker(organizationId: string, userId: string, input: CreateWorkerInput) {
    return this.workerEngagements.createWorker(organizationId, userId, input);
  }

  listEngagements(organizationId: string, workerId: string) {
    return this.workerEngagements.listEngagements(organizationId, workerId);
  }

  createEngagement(organizationId: string, userId: string, input: CreateEngagementInput) {
    return this.workerEngagements.createEngagement(organizationId, userId, input);
  }

  updateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: UpdateEngagementInput,
  ) {
    return this.workerEngagements.updateEngagement(
      organizationId,
      userId,
      workerEngagementId,
      input,
    );
  }

  cancelEngagement(organizationId: string, userId: string, workerEngagementId: string) {
    return this.workerEngagements.cancelEngagement(organizationId, userId, workerEngagementId);
  }

  terminateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: TerminateEngagementInput,
  ) {
    return this.workerEngagements.terminateEngagement(
      organizationId,
      userId,
      workerEngagementId,
      input,
    );
  }
}
