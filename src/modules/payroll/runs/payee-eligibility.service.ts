import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, ilike, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { resolvePerson } from "../../directory/person-seam";
import type { PersonEmployment, PersonResolutionPath } from "../../directory/person-seam";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";
import { payrollPeopleSource, toPayee } from "./lib/payroll-people";
import type { ListPayrollPeopleQuery } from "./dto/payroll-people.schemas";

export type PayeeEligibilityReason =
  | "payable"
  | "employed-but-not-payable"
  | "not-payable"
  | "unknown-person";

export type PayeeEligibility = {
  organizationPersonId: string;
  payable: boolean;
  payableAs: "user" | "worker" | null;
  payeeUserId: string | null;
  payeeWorkerId: string | null;
  resolvedVia: PersonResolutionPath | null;
  employment: PersonEmployment | null;
  reason: PayeeEligibilityReason;
};

@Injectable()
export class PayeeEligibilityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPeople(orgId: string, query: ListPayrollPeopleQuery) {
    const source = payrollPeopleSource(this.db, orgId);
    const position = query.cursor ? decodeTupleCursor(query.cursor, 2) : null;
    if (query.cursor && !position) throw new BadRequestException("Invalid cursor");
    const pattern = query.search ? `%${query.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null;

    const rows = await this.db
      .select({
        organizationPersonId: source.organizationPersonId,
        rowKey: source.rowKey,
        displayName: source.displayName,
        email: source.email,
        employeeNumber: source.employeeNumber,
        payeeKind: source.payeeKind,
        payeeId: source.payeeId,
        hasSalary: source.hasSalary,
        eligibility: source.eligibility,
      })
      .from(source)
      .where(
        and(
          pattern ? or(ilike(source.displayName, pattern), ilike(source.email, pattern)) : undefined,
          position ? sql`(${source.displayName}, ${source.rowKey}) > (${sql.param(position[0])}, ${sql.param(position[1])})` : undefined,
        ),
      )
      .orderBy(asc(source.displayName), asc(source.rowKey))
      .limit(query.limit + 1);

    const page = buildTupleCursorPage(rows, query.limit, (row) => [row.displayName, row.rowKey]);
    return {
      data: page.data.map((row) => ({
        organizationPersonId: row.organizationPersonId,
        displayName: row.displayName,
        email: row.email,
        employeeNumber: row.employeeNumber,
        payee: toPayee(row.payeeKind, row.payeeId),
        hasSalaryProfile: row.hasSalary === true,
        eligibility: row.eligibility,
      })),
      pagination: page.pagination,
    };
  }

  async getEligibility(
    orgId: string,
    organizationPersonId: string,
  ): Promise<PayeeEligibility> {
    const resolution = await resolvePerson(this.db, orgId, {
      kind: "person",
      organizationPersonId,
    });

    if (resolution.status !== "resolved") {
      return {
        organizationPersonId,
        payable: false,
        payableAs: null,
        payeeUserId: null,
        payeeWorkerId: null,
        resolvedVia: null,
        employment: null,
        reason: "unknown-person",
      };
    }

    const { payableAs, resolvedVia, employment } = resolution.person;

    return {
      organizationPersonId,
      payable: payableAs !== null,
      payableAs: payableAs?.kind ?? null,
      payeeUserId: payableAs?.kind === "user" ? payableAs.userId : null,
      payeeWorkerId: payableAs?.kind === "worker" ? payableAs.workerId : null,
      resolvedVia,
      employment,
      reason: eligibilityReason(payableAs !== null, employment),
    };
  }
}

function eligibilityReason(
  payable: boolean,
  employment: PersonEmployment | null,
): PayeeEligibilityReason {
  if (payable) return "payable";
  return employment ? "employed-but-not-payable" : "not-payable";
}
