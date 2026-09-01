import { Injectable, Inject } from "@nestjs/common";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  employeeSalaryProfileComponents,
  employeeSalaryProfiles,
  organizationPeople,
  salaryComponents,
  users,
  workers,
} from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type { ListProfilesQuery } from "./dto/runs.schemas";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollTextCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

const profileSortName = sql<string>`coalesce(
  ${users.name},
  ${organizationPeople.displayName},
  nullif(concat_ws(' ', ${organizationPeople.firstName}, ${organizationPeople.lastName}), ''),
  ${users.email},
  ${organizationPeople.workEmail},
  ''
)`;

const SALARY_PROFILE_COLUMNS = {
  id: employeeSalaryProfiles.id,
  userId: employeeSalaryProfiles.userId,
  workerId: employeeSalaryProfiles.workerId,
  workerType: employeeSalaryProfiles.workerType,
  currency: employeeSalaryProfiles.currency,
  payoutCurrency: employeeSalaryProfiles.payoutCurrency,
  annualCtc: employeeSalaryProfiles.annualCtc,
  taxRegime: employeeSalaryProfiles.taxRegime,
  costCenter: employeeSalaryProfiles.costCenter,
  status: employeeSalaryProfiles.status,
  effectiveFrom: employeeSalaryProfiles.effectiveFrom,
};

@Injectable()
export class SalaryProfilesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListProfilesQuery, scope: DataScope, userId: string) {
    const conditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: employeeSalaryProfiles.userId }),
      eq(employeeSalaryProfiles.status, query.status ?? "ACTIVE"),
    ];
    if (query.workerType) conditions.push(eq(employeeSalaryProfiles.workerType, query.workerType));
    if (query.costCenter) conditions.push(eq(employeeSalaryProfiles.costCenter, query.costCenter));
    const cursorScope = [
      "salary-profiles",
      orgId,
      scope,
      userId,
      query.search ?? null,
      query.workerType ?? null,
      query.status ?? "ACTIVE",
      query.costCenter ?? null,
    ] as const;
    const position = decodePayrollTextCursor(query.cursor, cursorScope);

    const search = query.search
      ? or(
          ilike(users.name, `%${query.search}%`),
          ilike(users.email, `%${query.search}%`),
          ilike(organizationPeople.displayName, `%${query.search}%`),
          ilike(organizationPeople.firstName, `%${query.search}%`),
          ilike(organizationPeople.lastName, `%${query.search}%`),
          ilike(organizationPeople.workEmail, `%${query.search}%`),
        )
      : undefined;
    const finalConditions = search ? [...conditions, search] : conditions;
    if (position) {
      finalConditions.push(
        sql`(${profileSortName}, ${employeeSalaryProfiles.id}) > (${position.value}, ${position.id})`,
      );
    }
    const joins = (queryBuilder: ReturnType<Db["select"]>) =>
      queryBuilder
        .from(employeeSalaryProfiles)
        .leftJoin(users, eq(users.id, employeeSalaryProfiles.userId))
        .leftJoin(workers, eq(workers.workerId, employeeSalaryProfiles.workerId))
        .leftJoin(
          organizationPeople,
          and(
            eq(organizationPeople.organizationPersonId, workers.organizationPersonId),
            eq(organizationPeople.organizationId, workers.organizationId),
          ),
        );
    const rows = await joins(
      this.db.select({
        ...SALARY_PROFILE_COLUMNS,
        userName: users.name,
        userEmail: users.email,
        workerDisplayName: organizationPeople.displayName,
        workerFirstName: organizationPeople.firstName,
        workerLastName: organizationPeople.lastName,
        workerEmail: organizationPeople.workEmail,
        sortName: profileSortName,
      }),
    )
      .where(and(...finalConditions))
      .orderBy(asc(profileSortName), asc(employeeSalaryProfiles.id))
      .limit(query.limit + 1);

    const page = buildCursorPage(rows, query.limit, (row) => {
      if (typeof row.id !== "number") throw new Error("Salary profile cursor requires a numeric id");
      return payrollCursorPosition(cursorScope, [String(row.sortName ?? "")], row.id);
    });

    return {
      data: page.data.map((row) => ({
        id: row.id,
        userId: row.userId,
        workerId: row.workerId,
        workerType: row.workerType,
        currency: row.currency,
        annualCtc: row.annualCtc,
        taxRegime: row.taxRegime,
        costCenter: row.costCenter,
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        userName:
          row.userName ??
          row.workerDisplayName ??
          ([row.workerFirstName, row.workerLastName].filter(Boolean).join(" ") || null),
        userEmail: row.userEmail ?? row.workerEmail,
      })),
      pagination: page.pagination,
    };
  }

  async findByUser(orgId: string, userId: string) {
    const [activeRows, history] = await Promise.all([
      this.db
        .select(SALARY_PROFILE_COLUMNS)
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.userId, userId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
          ),
        )
        .limit(1),
      this.historyByUser(orgId, userId),
    ]);
    const active = activeRows[0] ?? null;
    return { active, components: active ? await this.loadComponents(active.id) : [], history };
  }

  async findByWorker(orgId: string, workerId: string) {
    const [activeRows, history] = await Promise.all([
      this.db
        .select(SALARY_PROFILE_COLUMNS)
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.workerId, workerId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
          ),
        )
        .limit(1),
      this.historyByWorker(orgId, workerId),
    ]);
    const active = activeRows[0] ?? null;
    return { active, components: active ? await this.loadComponents(active.id) : [], history };
  }

  historyByUser(orgId: string, userId: string) {
    return this.db
      .select(SALARY_PROFILE_COLUMNS)
      .from(employeeSalaryProfiles)
      .where(and(eq(employeeSalaryProfiles.orgId, orgId), eq(employeeSalaryProfiles.userId, userId)))
      .orderBy(desc(employeeSalaryProfiles.effectiveFrom))
      .limit(100);
  }

  historyByWorker(orgId: string, workerId: string) {
    return this.db
      .select(SALARY_PROFILE_COLUMNS)
      .from(employeeSalaryProfiles)
      .where(and(eq(employeeSalaryProfiles.orgId, orgId), eq(employeeSalaryProfiles.workerId, workerId)))
      .orderBy(desc(employeeSalaryProfiles.effectiveFrom))
      .limit(100);
  }

  private loadComponents(profileId: number) {
    return this.db
      .select({
        id: employeeSalaryProfileComponents.id,
        componentId: employeeSalaryProfileComponents.componentId,
        calcMethodOverride: employeeSalaryProfileComponents.calcMethodOverride,
        amount: employeeSalaryProfileComponents.amount,
        percent: employeeSalaryProfileComponents.percent,
        formulaOverride: employeeSalaryProfileComponents.formulaOverride,
        sortOrder: employeeSalaryProfileComponents.sortOrder,
        code: salaryComponents.code,
        name: salaryComponents.name,
        type: salaryComponents.type,
        calcMethod: salaryComponents.calcMethod,
        taxable: salaryComponents.taxable,
      })
      .from(employeeSalaryProfileComponents)
      .innerJoin(salaryComponents, eq(salaryComponents.id, employeeSalaryProfileComponents.componentId))
      .where(eq(employeeSalaryProfileComponents.profileId, profileId))
      .orderBy(salaryComponents.sortOrder)
      .limit(100);
  }
}
