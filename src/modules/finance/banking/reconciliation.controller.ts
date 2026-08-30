import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ReconciliationService } from "./reconciliation.service";
import { ReconciliationWorkspaceService } from "./reconciliation-workspace.service";
import { ReconciliationRulesService } from "./reconciliation-rules.service";
import {
  confirmMatchSchema,
  unmatchSchema,
  ignoreTransactionSchema,
  createReconciliationRuleSchema,
  type ConfirmMatchInput,
  type UnmatchInput,
  type IgnoreTransactionInput,
  type CreateReconciliationRuleInput,
} from "./dto/reconciliation.schemas";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { Validate } from "../../../common/validation/validate.decorator";

const bankAccountIdParams = z.object({ bankAccountId: z.coerce.number().int().positive() }).strict();
const bankAccountAndRuleIdParams = z.object({ bankAccountId: z.coerce.number().int().positive(), ruleId: z.coerce.number().int().positive() }).strict();

const rulesQuerySchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

@RequireModule("accounting")
@Controller("finance/reconciliation/:bankAccountId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReconciliationController {
  constructor(
    private readonly service: ReconciliationService,
    private readonly workspace: ReconciliationWorkspaceService,
    private readonly rules: ReconciliationRulesService,
  ) {}

  @Get()
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  getWorkspace(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.getWorkspace(u, bankAccountId);
  }

  @Post("match")
  @HttpCode(200)
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  confirmMatch(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body(new ZodValidationPipe(confirmMatchSchema)) body: ConfirmMatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.confirmMatch(u, bankAccountId, body);
  }

  @Post("unmatch")
  @HttpCode(200)
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  unmatch(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body(new ZodValidationPipe(unmatchSchema)) body: UnmatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.unmatch(u, bankAccountId, body);
  }

  @Post("ignore")
  @HttpCode(200)
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  ignore(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body(new ZodValidationPipe(ignoreTransactionSchema)) body: IgnoreTransactionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.ignoreTransaction(u, bankAccountId, body);
  }

  @Get("rules")
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  listRules(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Query(new ZodValidationPipe(rulesQuerySchema)) query: { page: number; pageSize: number },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.listRules(u, { ...query, bankAccountId });
  }

  @Post("rules")
  @HttpCode(201)
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountIdParams })
  createRule(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body(new ZodValidationPipe(createReconciliationRuleSchema)) body: CreateReconciliationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.createRule(u, bankAccountId, body);
  }

  @Delete("rules/:ruleId")
  @RequirePermission("accounting:banking:reconcile")
  @Validate({ params: bankAccountAndRuleIdParams })
  deleteRule(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.deleteRule(u, bankAccountId, ruleId);
  }
}
