import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  count,
  eq,
  gt,
  ilike,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrEmployments,
  hrPeople,
} from "../../../db/schema/hr/core-people";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import type {
  ListEmploymentsInput,
  ListPeopleInput,
} from "./dto/hr-core.schemas";
import {
  decodeEmploymentListCursor,
  decodePeopleListCursor,
  encodeEmploymentListCursor,
  encodePeopleListCursor,
} from "./hr-core-list-cursors";

const MAX_PAGE_LIMIT = 100;

const PERSON_VIEW_COLUMNS = {
  id: hrPeople.id,
  orgId: hrPeople.orgId,
  userId: hrPeople.userId,
  firstName: hrPeople.firstName,
  lastName: hrPeople.lastName,
  workEmail: hrPeople.workEmail,
  phone: hrPeople.phone,
  gender: hrPeople.gender,
  avatarUrl: hrPeople.avatarUrl,
  createdAt: hrPeople.createdAt,
  updatedAt: hrPeople.updatedAt,
};

const EMPLOYMENT_VIEW_COLUMNS = {
  id: hrEmployments.id,
  orgId: hrEmployments.orgId,
  personId: hrEmployments.personId,
  employeeNumber: hrEmployments.employeeNumber,
  lifecycleStatus: hrEmployments.lifecycleStatus,
  workerType: hrEmployments.workerType,
  departmentId: hrEmployments.departmentId,
  jobRoleId: hrEmployments.jobRoleId,
  jobLevelId: hrEmployments.jobLevelId,
  employmentTypeId: hrEmployments.employmentTypeId,
  locationId: hrEmployments.locationId,
  designation: hrEmployments.designation,
  joiningDate: hrEmployments.joiningDate,
  probationEndDate: hrEmployments.probationEndDate,
  confirmationDate: hrEmployments.confirmationDate,
  noticeStartDate: hrEmployments.noticeStartDate,
  expectedLastDay: hrEmployments.expectedLastDay,
  lastWorkingDay: hrEmployments.lastWorkingDay,
  isPrimary: hrEmployments.isPrimary,
  createdAt: hrEmployments.createdAt,
  updatedAt: hrEmployments.updatedAt,
};

type PersonListRecord = Pick<
  typeof hrPeople.$inferSelect,
  keyof typeof PERSON_VIEW_COLUMNS
>;

type EmploymentListRecord = Pick<
  typeof hrEmployments.$inferSelect,
  keyof typeof EMPLOYMENT_VIEW_COLUMNS
>;

type CursorListResponse<RecordType> = {
  data: RecordType[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

type LegacyPageResponse<RecordType> = {
  data: RecordType[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

function boundPageLimit(requestedLimit: number): number {
  return Math.min(Math.max(requestedLimit, 1), MAX_PAGE_LIMIT);
}

@Injectable()
export class HrEmployeeRecordListsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPeopleCursor(
    orgId: string,
    actorUserId: string,
    query: Pick<ListPeopleInput, "cursor" | "limit" | "search">,
    scope: DataScope,
  ): Promise<CursorListResponse<PersonListRecord>> {
    const pageLimit = boundPageLimit(query.limit);
    const conditions = this.peopleConditions(
      orgId,
      actorUserId,
      scope,
      query.search,
    );
    if (query.cursor) {
      const cursor = decodePeopleListCursor(query.cursor);
      conditions.push(gt(hrPeople.id, cursor.personId));
    }

    const result = await this.db
      .select(PERSON_VIEW_COLUMNS)
      .from(hrPeople)
      .where(and(...conditions))
      .orderBy(asc(hrPeople.id))
      .limit(pageLimit + 1);
    const hasMore = result.length > pageLimit;
    const data = result.slice(0, pageLimit);
    const lastPerson = data.at(-1);

    return {
      data,
      pageInfo: {
        limit: pageLimit,
        hasMore,
        nextCursor:
          hasMore && lastPerson
            ? encodePeopleListCursor({ personId: lastPerson.id })
            : null,
      },
    };
  }

  async listPeoplePage(
    orgId: string,
    actorUserId: string,
    query: Pick<ListPeopleInput, "limit" | "page" | "search"> & {
      page: number;
    },
    scope: DataScope,
  ): Promise<LegacyPageResponse<PersonListRecord>> {
    const pageLimit = boundPageLimit(query.limit);
    const conditions = this.peopleConditions(
      orgId,
      actorUserId,
      scope,
      query.search,
    );
    const where = and(...conditions);
    const [data, totalRows] = await Promise.all([
      this.db
        .select(PERSON_VIEW_COLUMNS)
        .from(hrPeople)
        .where(where)
        .orderBy(asc(hrPeople.firstName), asc(hrPeople.id))
        .limit(pageLimit)
        .offset((query.page - 1) * pageLimit),
      this.db.select({ total: count() }).from(hrPeople).where(where),
    ]);
    const total = totalRows[0]?.total ?? 0;

    return {
      data,
      pagination: {
        page: query.page,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
    };
  }

  async listEmploymentsCursor(
    orgId: string,
    actorUserId: string,
    query: Pick<ListEmploymentsInput, "cursor" | "limit">,
    scope: DataScope,
  ): Promise<CursorListResponse<EmploymentListRecord>> {
    const pageLimit = boundPageLimit(query.limit);
    const conditions = this.employmentConditions(orgId, actorUserId, scope);
    if (query.cursor) {
      const cursor = decodeEmploymentListCursor(query.cursor);
      conditions.push(gt(hrEmployments.id, cursor.employmentId));
    }

    const result = await this.db
      .select(EMPLOYMENT_VIEW_COLUMNS)
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, hrEmployments.orgId),
          eq(hrPeople.id, hrEmployments.personId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(hrEmployments.id))
      .limit(pageLimit + 1);
    const hasMore = result.length > pageLimit;
    const data = result.slice(0, pageLimit);
    const lastEmployment = data.at(-1);

    return {
      data,
      pageInfo: {
        limit: pageLimit,
        hasMore,
        nextCursor:
          hasMore && lastEmployment
            ? encodeEmploymentListCursor({
                employmentId: lastEmployment.id,
              })
            : null,
      },
    };
  }

  async listEmploymentsPage(
    orgId: string,
    actorUserId: string,
    query: Pick<ListEmploymentsInput, "limit" | "page"> & { page: number },
    scope: DataScope,
  ): Promise<LegacyPageResponse<EmploymentListRecord>> {
    const pageLimit = boundPageLimit(query.limit);
    const conditions = this.employmentConditions(orgId, actorUserId, scope);
    const where = and(...conditions);
    const employmentJoin = and(
      eq(hrPeople.orgId, hrEmployments.orgId),
      eq(hrPeople.id, hrEmployments.personId),
    );
    const [data, totalRows] = await Promise.all([
      this.db
        .select(EMPLOYMENT_VIEW_COLUMNS)
        .from(hrEmployments)
        .innerJoin(hrPeople, employmentJoin)
        .where(where)
        .orderBy(asc(hrEmployments.id))
        .limit(pageLimit)
        .offset((query.page - 1) * pageLimit),
      this.db
        .select({ total: count() })
        .from(hrEmployments)
        .innerJoin(hrPeople, employmentJoin)
        .where(where),
    ]);
    const total = totalRows[0]?.total ?? 0;

    return {
      data,
      pagination: {
        page: query.page,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
    };
  }

  private peopleConditions(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    search: string | undefined,
  ): SQL[] {
    const conditions: SQL[] = [
      eq(hrPeople.orgId, orgId),
      isNull(hrPeople.deletedAt),
      applyScope(scope, orgId, actorUserId, {
        ownerColumn: hrPeople.userId,
      }),
    ];
    if (search) {
      const searchCondition = or(
        ilike(hrPeople.firstName, `%${search}%`),
        ilike(hrPeople.lastName, `%${search}%`),
        ilike(hrPeople.workEmail, `%${search}%`),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    return conditions;
  }

  private employmentConditions(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
  ): SQL[] {
    return [
      eq(hrEmployments.orgId, orgId),
      isNull(hrEmployments.deletedAt),
      eq(hrPeople.orgId, orgId),
      isNull(hrPeople.deletedAt),
      applyScope(scope, orgId, actorUserId, {
        ownerColumn: hrPeople.userId,
      }),
    ];
  }
}
