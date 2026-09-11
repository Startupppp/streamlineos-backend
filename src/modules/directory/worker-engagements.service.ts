import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { AuditService } from "../../common/audit/audit.service";
import { getPostgresErrorCode } from "../../common/db/postgres-error";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  organizationPeople,
  workerEngagements,
  workers,
} from "../../db/schema/directory";
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
  throwEngagementWriteError,
} from "./worker-engagement-errors";
import {
  cancelEngagement,
  terminateEngagement,
  updateEngagement,
  type EngagementTransitionDeps,
} from "./lib/engagement-transitions";

const PG_UNIQUE_VIOLATION = "23505";
const WORKER_SEARCH_CAP = 500;

type PersonRow = typeof organizationPeople.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

@Injectable()
export class WorkerEngagementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly identities: DirectoryPersonEnsureService,
  ) {}

  private get engagementDeps(): EngagementTransitionDeps {
    return { db: this.db, audit: this.audit };
  }

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
        if (getPostgresErrorCode(error) === PG_UNIQUE_VIOLATION) {
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

  /** @see updateEngagement — optimistic patch guarded by rowVersion. */
  async updateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: UpdateEngagementInput,
  ) {
    return updateEngagement(
      this.engagementDeps,
      organizationId,
      userId,
      workerEngagementId,
      input,
    );
  }

  /** @see cancelEngagement — PLANNED only; an active engagement is ended. */
  async cancelEngagement(organizationId: string, userId: string, workerEngagementId: string) {
    return cancelEngagement(this.engagementDeps, organizationId, userId, workerEngagementId);
  }

  /** @see terminateEngagement — ACTIVE only, also guarded by rowVersion. */
  async terminateEngagement(
    organizationId: string,
    userId: string,
    workerEngagementId: string,
    input: TerminateEngagementInput,
  ) {
    return terminateEngagement(
      this.engagementDeps,
      organizationId,
      userId,
      workerEngagementId,
      input,
    );
  }
}
