import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  hrEmployments,
  hrPeople,
  terminations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import {
  loadTerminationRelationalCollections,
} from "./termination-relational-compat";
import type { ListTerminationsQueryInput } from "./dto/hr-lifecycle.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

@Injectable()
export class TerminationReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async list(orgId: string, params: ListTerminationsQueryInput) {
    const limit = Math.min(params.limit, 100);
    const conditions = [eq(terminations.orgId, orgId)];
    if (params.status) conditions.push(eq(terminations.status, params.status));
    const position = decodeCursor(params.cursor);
    if (position)
      conditions.push(keysetBeforeId(terminations.createdAt, terminations.id, position));
    const where = and(...conditions);
    const [data, statusRows] = await Promise.all([
      this.db
        .select({
          id: terminations.id,
          orgId: terminations.orgId,
          userId: terminations.userId,
          status: terminations.status,
          reasons: terminations.reasons,
          detailedExplanation: terminations.detailedExplanation,
          effectiveDate: terminations.effectiveDate,
          severanceAmount: terminations.severanceAmount,
          noticePeriodWaived: terminations.noticePeriodWaived,
          internalNotes: terminations.internalNotes,
          createdAt: terminations.createdAt,
          updatedAt: terminations.updatedAt,
          finalRemarks: terminations.finalRemarks,
          finalReviewedBy: terminations.finalReviewedBy,
          finalReviewedAt: terminations.finalReviewedAt,
          emailSentAt: terminations.emailSentAt,
          emailStatus: terminations.emailStatus,
          initiatedBy: terminations.initiatedBy,
          employee: {
            id: users.id,
            name: users.name,
            email: users.email,
            designation: hrEmployments.designation,
            employeeId: hrEmployments.employeeNumber,
          },
        })
        .from(terminations)
        .leftJoin(users, eq(terminations.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(where)
        .orderBy(desc(terminations.createdAt), desc(terminations.id))
        .limit(limit + 1),
      this.db
        .select({ status: terminations.status, count: sql<number>`count(*)` })
        .from(terminations)
        .where(eq(terminations.orgId, orgId))
      .groupBy(terminations.status),
    ]);
    const statusCounts: Record<string, number> = {};
    let orgTotal = 0;
    for (const row of statusRows) {
      const rowCount = Number(row.count ?? 0);
      if (row.status) statusCounts[row.status] = rowCount;
      orgTotal += rowCount;
    }
    const page = buildCursorPage(data, limit, (termination) => ({
      sortValue: termination.createdAt.toISOString(),
      id: String(termination.id),
    }));
    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      page.data.map((termination) => termination.id),
    );
    const compatibleData = page.data.map((termination) => ({
      ...termination,
      reasons: resolveCompatibleList(
        termination.reasons,
        relationalCollections.reasonsByTerminationId.get(termination.id),
      ),
    }));
    return {
      data: compatibleData,
      pagination: page.pagination,
      statusCounts: { ...statusCounts, ALL: orgTotal },
    };
  }

  async getOne(orgId: string, terminationId: number) {
    const data = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        initiator: { columns: { id: true, name: true } },
        finalReviewer: { columns: { id: true, name: true } },
      },
    });
    if (!data) throw new NotFoundException("Termination not found.");
    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      orgId,
      [data.id],
    );
    const facts = data.user
      ? await this.employmentFacts.getFacts(orgId, data.user.id)
      : null;
    return {
      ...data,
      user: data.user
        ? {
            ...data.user,
            designation: facts?.designation ?? null,
            joiningDate: facts?.joiningDate ?? null,
          }
        : data.user,
      reasons: resolveCompatibleList(
        data.reasons,
        relationalCollections.reasonsByTerminationId.get(data.id),
      ),
      supportingDocUrls:
        data.supportingDocUrls === null
          ? null
          : resolveCompatibleList(
              data.supportingDocUrls,
              relationalCollections.supportingDocumentsByTerminationId.get(data.id),
            ),
    };
  }
}
