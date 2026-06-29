import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccountingStatementsService } from "./accounting-statements.service";
import {
  balanceSheetQuerySchema,
  profitLossQuerySchema,
  trialBalanceQuerySchema,
  type BalanceSheetQuery,
  type ProfitLossQuery,
  type TrialBalanceQuery,
} from "./dto/accounting.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AccountingStatementsController {
  constructor(private readonly statements: AccountingStatementsService) {}

  @Get("trial-balance")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  trialBalance(
    @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.trialBalance(u.orgId, query);
  }

  @Get("profit-loss")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  profitLoss(
    @Query(new ZodValidationPipe(profitLossQuerySchema)) query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.profitLoss(u.orgId, query);
  }

  @Get("balance-sheet")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  balanceSheet(
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.balanceSheet(u.orgId, query);
  }

  @Get("cash-flow")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  cashFlow(
    @Query(new ZodValidationPipe(profitLossQuerySchema)) query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.cashFlow(u.orgId, query);
  }
}
