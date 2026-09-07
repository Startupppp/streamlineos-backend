import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingStatementsService } from "./accounting-statements.service";
import {
  balanceSheetQuerySchema,
  profitLossQuerySchema,
  trialBalanceQuerySchema,
  type BalanceSheetQuery,
  type ProfitLossQuery,
  type TrialBalanceQuery,
} from "./dto/accounting.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  trialBalanceResponseSchema,
  profitLossResponseSchema,
  balanceSheetResponseSchema,
  cashFlowResponseSchema,
} from "./dto/accounting-statements-response.schemas";

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AccountingStatementsController {
  constructor(private readonly statements: AccountingStatementsService) {}

  @Get("trial-balance")
  @ResponseSchema(trialBalanceResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: trialBalanceQuerySchema })
  trialBalance(
    @Query() query: TrialBalanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.trialBalance(u.orgId, query);
  }

  @Get("profit-loss")
  @ResponseSchema(profitLossResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: profitLossQuerySchema })
  profitLoss(
    @Query() query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.profitLoss(u.orgId, query);
  }

  @Get("balance-sheet")
  @ResponseSchema(balanceSheetResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: balanceSheetQuerySchema })
  balanceSheet(
    @Query() query: BalanceSheetQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.balanceSheet(u.orgId, query);
  }

  @Get("cash-flow")
  @ResponseSchema(cashFlowResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: profitLossQuerySchema })
  cashFlow(
    @Query() query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.cashFlow(u.orgId, query);
  }
}
