import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { MatchingService } from "./matching.service";
import {
  matchCounterpartSchema,
  suggestionsQuerySchema,
  unreconciledQuerySchema,
  type MatchCounterpartBody,
  type SuggestionsQuery,
  type UnreconciledQuery,
} from "./dto/banking.schemas";

@RequireModule("accounting")
@Controller("accounting/banking")
@UseGuards(JwtAuthGuard)
export class BankMatchingController {
  constructor(private readonly matching: MatchingService) {}

  /** Rules-only candidates, each carrying the reasons it scored what it did. */
  @Get("statement-lines/:statementLineId/suggestions")
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

  @Delete("statement-lines/:statementLineId/match")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:reconcile")
  @HttpCode(200)
  unmatch(@Param("statementLineId") statementLineId: string, @CurrentUser() u: CurrentUserContext) {
    return this.matching.unmatch(u.orgId, statementLineId);
  }

  /** Both halves of the difference: the bank's unexplained, and the books'. */
  @Get("unreconciled")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  unreconciled(
    @Query(new ZodValidationPipe(unreconciledQuerySchema)) query: UnreconciledQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.matching.listUnreconciled(u.orgId, query);
  }
}
