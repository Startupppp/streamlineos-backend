import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
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

@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AccountingStatementsController {
  constructor(private readonly statements: AccountingStatementsService) {}

  @Get("trial-balance")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  trialBalance(
    @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.trialBalance(u.orgId, query);
  }

  @Get("profit-loss")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  profitLoss(
    @Query(new ZodValidationPipe(profitLossQuerySchema)) query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.profitLoss(u.orgId, query);
  }

  @Get("balance-sheet")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  balanceSheet(
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.balanceSheet(u.orgId, query);
  }

  @Get("cash-flow")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  cashFlow(
    @Query(new ZodValidationPipe(profitLossQuerySchema)) query: ProfitLossQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statements.cashFlow(u.orgId, query);
  }
}
