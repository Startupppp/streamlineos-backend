import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
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
const PERSON_SEARCH_CAP = 500;

const PERSON_JOIN_COND = and(
  eq(organizationPeople.organizationId, hrPeople.orgId),
  eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
  isNull(organizationPeople.deletedAt),
);

const PERSON_VIEW_COLUMNS = {
  id: hrPeople.id,
  orgId: hrPeople.orgId,
  userId: hrPeople.userId,
  organizationPersonId: hrPeople.organizationPersonId,
  firstName: organizationPeople.firstName,
  lastName: organizationPeople.lastName,
  workEmail: organizationPeople.workEmail,
  phone: organizationPeople.phone,
  gender: organizationPeople.gender,
  avatarUrl: organizationPeople.avatarUrl,
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
  "id" | "orgId" | "userId" | "organizationPersonId" | "createdAt" | "updatedAt"
> &
  Pick<
    typeof organizationPeople.$inferSelect,
    "firstName" | "lastName" | "workEmail" | "phone" | "gender" | "avatarUrl"
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
    const conditions = this.peopleConditions(orgId, actorUserId, scope);
    if (query.cursor) {
      const cursor = decodePeopleListCursor(query.cursor, {
        orgId,
        actorUserId,
        scope,
        search: query.search ?? null,
      });
      conditions.push(gt(hrPeople.id, cursor.personId));
    }
    if (query.search)
      conditions.push(await this.personSearchCondition(query.search));

    const result = await this.db
      .select(PERSON_VIEW_COLUMNS)
      .from(hrPeople)
      .innerJoin(organizationPeople, PERSON_JOIN_COND)
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
            ? encodePeopleListCursor({
                personId: lastPerson.id,
                orgId,
                actorUserId,
                scope,
                search: query.search ?? null,
              })
            : null,
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
      const cursor = decodeEmploymentListCursor(query.cursor, {
        orgId,
        actorUserId,
        scope,
      });
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
                orgId,
                actorUserId,
                scope,
              })
            : null,
      },
    };
  }

  private peopleConditions(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
  ): SQL[] {
    return [
      eq(hrPeople.orgId, orgId),
      isNull(hrPeople.deletedAt),
      applyScope(scope, orgId, actorUserId, {
        ownerColumn: hrPeople.userId,
      }),
    ];
  }

  private async personSearchCondition(search: string): Promise<SQL> {
    const fallback = or(
      ilike(organizationPeople.firstName, `%${search}%`),
      ilike(organizationPeople.lastName, `%${search}%`),
      ilike(organizationPeople.workEmail, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_person_ids(${search}, ${PERSON_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > PERSON_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(hrPeople.id, ids);
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
