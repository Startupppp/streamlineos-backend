import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { MatchingService } from "./matching.service";
import { ExplainLineService } from "./explain-line.service";
import {
  explainLineSchema,
  matchCounterpartSchema,
  suggestionsQuerySchema,
  unreconciledQuerySchema,
  type MatchCounterpartBody,
  type SuggestionsQuery,
  type UnreconciledQuery,
  type ExplainLineBody,
} from "./dto/banking.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  explainStatementLineResponseSchema,
  matchStatementLineResponseSchema,
  matchSuggestionsResponseSchema,
  unmatchStatementLineResponseSchema,
  unreconciledResponseSchema,
} from "./dto/banking-response.schemas";

@RequireModule("accounting")
@Controller("accounting/banking")
@UseGuards(JwtAuthGuard)
export class BankMatchingController {
  constructor(private readonly matching: MatchingService, private readonly explainLine: ExplainLineService) {}

  /** Rules-only candidates, each carrying the reasons it scored what it did. */
  @Get("statement-lines/:statementLineId/suggestions")
  @ResponseSchema(matchSuggestionsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  suggest(
    @Param("statementLineId") statementLineId: string,
    @Query(new ZodValidationPipe(suggestionsQuerySchema)) query: SuggestionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.matching.suggestMatches(u.orgId, statementLineId, query);
  }

  @Post("statement-lines/:statementLineId/match")
  @ResponseSchema(matchStatementLineResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  @HttpCode(201)
  match(
    @Param("statementLineId") statementLineId: string,
    @Body(new ZodValidationPipe(matchCounterpartSchema)) body: MatchCounterpartBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.matching.match(u.orgId, u.userId, statementLineId, body);
  }

  /**
   * Post a journal for a line nothing explains, and match it — one action, one
   * transaction (PRD 04 S2). Bank charges and interest have no receipt or
   * payment to match against, and the second step is the one people skip.
   */
  @Post("statement-lines/:statementLineId/explain")
  @ResponseSchema(explainStatementLineResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  @HttpCode(201)
  explain(
    @Param("statementLineId") statementLineId: string,
    @Body(new ZodValidationPipe(explainLineSchema)) body: ExplainLineBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainLine.explain(u.orgId, u.userId, statementLineId, body);
  }

  @Delete("statement-lines/:statementLineId/match")
  @ResponseSchema(unmatchStatementLineResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  @HttpCode(200)
  unmatch(@Param("statementLineId") statementLineId: string, @CurrentUser() u: CurrentUserContext) {
    return this.matching.unmatch(u.orgId, statementLineId);
  }

  /** Both halves of the difference: the bank's unexplained, and the books'. */
  @Get("unreconciled")
  @ResponseSchema(unreconciledResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  unreconciled(
    @Query(new ZodValidationPipe(unreconciledQuerySchema)) query: UnreconciledQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.matching.listUnreconciled(u.orgId, query);
  }
}
