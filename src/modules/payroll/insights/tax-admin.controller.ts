import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Response } from "express";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { taxDeclarations, users } from "../../../db/schema";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildCsv } from "./lib/csv";

@Controller("payroll/tax")
@UseGuards(JwtAuthGuard)
export class TaxAdminController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get("declarations")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:tax:view")
  listDeclarations(
    @CurrentUser() u: CurrentUserContext,
    @Query("financialYear") fy?: string,
    @Query("status") status?: string,
  ) {
    const base = eq(taxDeclarations.orgId, u.orgId);
    const whereClause =
      fy || status
        ? and(
            base,
            fy ? eq(taxDeclarations.financialYear, fy) : undefined,
            status ? eq(taxDeclarations.status, status) : undefined,
          )
        : base;

    return this.db
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
        status: taxDeclarations.status,
        verifiedBy: taxDeclarations.verifiedBy,
        verifiedAt: taxDeclarations.verifiedAt,
        createdAt: taxDeclarations.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(taxDeclarations)
      .leftJoin(users, eq(taxDeclarations.userId, users.id))
      .where(whereClause)
      .limit(100);
  }

  @Patch("declarations/:declarationId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:tax:manage")
  async approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("declarationId", ParseIntPipe) declarationId: number,
  ) {
    const [updated] = await this.db
      .update(taxDeclarations)
      .set({ status: "VERIFIED", verifiedBy: u.userId, verifiedAt: new Date() })
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, u.orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Tax declaration not found");
    return updated;
  }

  @Patch("declarations/:declarationId/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:tax:manage")
  async reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("declarationId", ParseIntPipe) declarationId: number,
  ) {
    const [updated] = await this.db
      .update(taxDeclarations)
      .set({ status: "DRAFT" })
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, u.orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Tax declaration not found");
    return updated;
  }

  @Get("export")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:reports:export")
  async export(
    @CurrentUser() u: CurrentUserContext,
    @Query("financialYear") fy?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const base = eq(taxDeclarations.orgId, u.orgId);
    const whereClause = fy ? and(base, eq(taxDeclarations.financialYear, fy)) : base;

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
        status: taxDeclarations.status,
        createdAt: taxDeclarations.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(taxDeclarations)
      .leftJoin(users, eq(taxDeclarations.userId, users.id))
      .where(whereClause)
      .limit(1000);

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
      r.status,
      r.createdAt?.toISOString() ?? "",
    ]);

    const csv = buildCsv(headers, csvRows);

    res?.setHeader("Content-Type", "text/csv");
    res?.setHeader(
      "Content-Disposition",
      `attachment; filename="tax-declarations-${fy ?? "all"}.csv"`,
    );

    return csv;
  }
}
