import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { taxDeclarations, users } from "../../../db/schema";
import { buildCsv } from "./lib/csv";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

@Injectable()
export class TaxAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listDeclarations(
    orgId: string,
    filters: { financialYear?: string; status?: string },
    cursor?: string,
    limit = 50,
  ) {
    const cap = Math.min(limit, 100);
    const cursorScope = [
      "tax-declarations",
      orgId,
      filters.financialYear ?? null,
      filters.status ?? null,
    ] as const;
    const position = decodePayrollTimestampCursor(cursor, cursorScope);
    const where = this.scopeWhere(orgId, filters);
    const rows = await this.db
      .select({
        id: taxDeclarations.id,
        orgId: taxDeclarations.orgId,
        userId: taxDeclarations.userId,
        financialYear: taxDeclarations.financialYear,
        regime: taxDeclarations.regime,
        hra: taxDeclarations.hra,
        lta: taxDeclarations.lta,
        section80c: taxDeclarations.section80c,
        section80d: taxDeclarations.section80d,
        section80g: taxDeclarations.section80g,
        homeLoanInterest: taxDeclarations.homeLoanInterest,
        previousEmploymentIncome: taxDeclarations.previousEmploymentIncome,
        previousEmployerTds: taxDeclarations.previousEmployerTds,
        status: taxDeclarations.status,
        verifiedBy: taxDeclarations.verifiedBy,
        verifiedAt: taxDeclarations.verifiedAt,
        reviewNote: taxDeclarations.reviewNote,
        createdAt: taxDeclarations.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(taxDeclarations)
      .leftJoin(users, eq(taxDeclarations.userId, users.id))
      .where(
        and(
          where,
          position
            ? or(
                lt(taxDeclarations.createdAt, position.createdAt),
                and(
                  eq(taxDeclarations.createdAt, position.createdAt),
                  gt(taxDeclarations.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(taxDeclarations.createdAt), asc(taxDeclarations.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(cursorScope, [row.createdAt.toISOString()], row.id),
    );
  }

  async approve(orgId: string, verifierId: string, declarationId: number) {
    const [updated] = await this.db
      .update(taxDeclarations)
      .set({ status: "VERIFIED", verifiedBy: verifierId, verifiedAt: new Date() })
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Tax declaration not found");
    return updated;
  }

  async reject(orgId: string, declarationId: number, note?: string) {
    const [updated] = await this.db
      .update(taxDeclarations)
      .set({ status: "DRAFT", reviewNote: note?.trim() || null })
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Tax declaration not found");
    return updated;
  }

  async exportCsv(
    orgId: string,
    financialYear?: string,
  ): Promise<{ filename: string; contentType: string; body: string }> {
    const rows = await this.db
      .select({
        id: taxDeclarations.id,
        financialYear: taxDeclarations.financialYear,
        regime: taxDeclarations.regime,
        hra: taxDeclarations.hra,
        lta: taxDeclarations.lta,
        section80c: taxDeclarations.section80c,
        section80d: taxDeclarations.section80d,
        section80g: taxDeclarations.section80g,
        homeLoanInterest: taxDeclarations.homeLoanInterest,
        previousEmploymentIncome: taxDeclarations.previousEmploymentIncome,
        previousEmployerTds: taxDeclarations.previousEmployerTds,
        status: taxDeclarations.status,
        createdAt: taxDeclarations.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(taxDeclarations)
      .leftJoin(users, eq(taxDeclarations.userId, users.id))
      .where(this.scopeWhere(orgId, { financialYear }))
      .limit(100);

    const headers = [
      "ID",
      "Employee Name",
      "Email",
      "Financial Year",
      "Regime",
      "HRA",
      "LTA",
      "Section 80C",
      "Section 80D",
      "Section 80G",
      "Home Loan Interest",
      "Previous Employment Income",
      "Previous Employer TDS",
      "Status",
      "Created At",
    ];

    const csvRows = rows.map((r) => [
      r.id,
      r.userName,
      r.userEmail,
      r.financialYear,
      r.regime,
      r.hra,
      r.lta,
      r.section80c,
      r.section80d,
      r.section80g,
      r.homeLoanInterest,
      r.previousEmploymentIncome,
      r.previousEmployerTds,
      r.status,
      r.createdAt?.toISOString() ?? "",
    ]);

    return {
      filename: `tax-declarations-${financialYear ?? "all"}.csv`,
      contentType: "text/csv",
      body: buildCsv(headers, csvRows),
    };
  }

  private scopeWhere(orgId: string, filters: { financialYear?: string; status?: string }) {
    const base = eq(taxDeclarations.orgId, orgId);
    if (!filters.financialYear && !filters.status) return base;
    return and(
      base,
      filters.financialYear ? eq(taxDeclarations.financialYear, filters.financialYear) : undefined,
      filters.status ? eq(taxDeclarations.status, filters.status) : undefined,
    );
  }
}
