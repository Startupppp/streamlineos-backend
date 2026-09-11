import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { StatementImportService } from "./statement-import.service";
import { ReconciliationService } from "./reconciliation.service";
import { reconciliationCsv } from "./reconciliation-csv";
import { csvFilename } from "../reports/report-csv";
import {
  importStatementSchema,
  listStatementsQuerySchema,
  statementLinesQuerySchema,
  type ImportStatementBody,
  type ListStatementsQuery,
  type StatementLinesQuery,
} from "./dto/banking.schemas";

@RequireModule("accounting")
@Controller("accounting/banking/statements")
@UseGuards(JwtAuthGuard)
export class BankStatementsController {
  constructor(
    private readonly statements: StatementImportService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** The shipped CSV layouts. Data, so a UI can render the picker from it. */
  @Get("mapping-presets")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  listPresets() {
    return { presets: this.statements.listPresets() };
  }

  /**
   * Import a CSV. The file is a string field in the JSON body — a statement is
   * text, and hashing that text is what makes a re-import a 409 instead of a
   * duplicated month.
   */
  @Post("imports")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:import")
  @HttpCode(201)
  import(
    @Body(new ZodValidationPipe(importStatementSchema)) body: ImportStatementBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.import(u.orgId, u.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  list(
    @Query(new ZodValidationPipe(listStatementsQuerySchema)) query: ListStatementsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.listStatements(u.orgId, query);
  }

  @Get(":statementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  get(
    @Param("statementId") statementId: string,
    @Query(new ZodValidationPipe(statementLinesQuerySchema)) query: StatementLinesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.getStatement(u.orgId, statementId, query);
  }

  /** Every term of the proof, so a UI can show *why* cash and bank differ. */
  @Get(":statementId/reconciliation")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  proof(@Param("statementId") statementId: string, @CurrentUser() u: CurrentUserContext) {
    return this.reconciliation.getRecProof(u.orgId, statementId);
  }

  /** The same proof as CSV, for a file an accountant can keep (PRD 04 S3). */
  @Get(":statementId/reconciliation/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async exportProof(
    @Param("statementId") statementId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const proof = await this.reconciliation.getRecProof(u.orgId, statementId);
    const filename = csvFilename(["bank-reconciliation", proof.periodEnd]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return reconciliationCsv(proof);
  }

  @Post(":statementId/reconcile")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  @HttpCode(200)
  reconcile(@Param("statementId") statementId: string, @CurrentUser() u: CurrentUserContext) {
    return this.reconciliation.markReconciled(u.orgId, u.userId, statementId);
  }
}
