import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { DealsCompetitorSuggestionsService } from "./deals-competitor-suggestions.service";
import {
  acceptCompetitorSuggestionSchema,
  dismissCompetitorSuggestionSchema,
  listCompetitorSuggestionsSchema,
  type AcceptCompetitorSuggestionInput,
  type DismissCompetitorSuggestionInput,
  type ListCompetitorSuggestionsInput,
} from "./dto/competitor-suggestions.schemas";
import {
  listCompetitorSuggestionsResponseSchema,
  scanCompetitorSuggestionsResponseSchema,
  acceptCompetitorSuggestionResponseSchema,
  dismissCompetitorSuggestionResponseSchema,
} from "./dto/competitor-suggestions-response.schemas";

/**
 * The suggestion half of deal competitors.
 *
 * CRM-P2-12. A separate controller from `DealsCompetitorsController` rather than
 * four more handlers on it, because the two answer different questions and are
 * held to different rules: that one states facts a person typed, this one raises
 * questions and records answers. Somebody auditing "how can a competitor appear
 * on a deal" should find two files with two stories, not one file where the
 * second story is four methods further down.
 *
 * The permission keys are deliberately the *same* ones the manual path uses.
 * Reading a proposal tells you no more than reading the deal's timeline, which
 * `crm:deals:read` already grants; accepting one writes precisely the row
 * `POST /deals/:dealId/competitors` writes, which is `crm:deals:update`. A new
 * key here would be a third answer to a question the catalog has already
 * answered twice, and would give somebody a way to hold the write without
 * holding the write.
 */
@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsCompetitorSuggestionsController {
  constructor(private readonly suggestions: DealsCompetitorSuggestionsService) {}

  @Get(":dealId/competitor-suggestions")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(listCompetitorSuggestionsResponseSchema)
  list(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Query(new ZodValidationPipe(listCompetitorSuggestionsSchema))
    query: ListCompetitorSuggestionsInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.suggestions.list(user.orgId, dealId, query);
  }

  /**
   * `POST` because it writes, even though it reads to decide what to write.
   *
   * The write is the point: a scan that returned proposals without filing them
   * would have to re-derive them at accept time, and a proposal a person is
   * looking at must be the same row they act on rather than a recomputation that
   * may disagree.
   */
  @Post(":dealId/competitor-suggestions/scan")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("crm:deals:update")
  @ResponseSchema(scanCompetitorSuggestionsResponseSchema)
  scan(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.suggestions.scan(user.orgId, dealId);
  }

  /**
   * The actor comes from the token and never from the body.
   *
   * `@CurrentUser()` is the whole of the identity here — a client-supplied
   * `decidedByUserId` would let one person file another's approval, which on a
   * surface whose only job is to record who agreed would defeat the feature
   * rather than merely be a bug.
   */
  @Post(":dealId/competitor-suggestions/:suggestionId/accept")
  @HttpCode(200)
  @RequirePermission("crm:deals:update")
  /**
   * Fenced, because accepting is the one call here that writes a competitor
   * row. Without it a retried request — a double-tap, a proxy replay — files
   * the same agreement twice against a customer record, and the second one is
   * indistinguishable from a person who really did agree twice.
   */
  @Idempotent("crm.deals.competitor_suggestion_accept")
  @ResponseSchema(acceptCompetitorSuggestionResponseSchema)
  accept(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("suggestionId") suggestionId: string,
    @Body(new ZodValidationPipe(acceptCompetitorSuggestionSchema))
    body: AcceptCompetitorSuggestionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.suggestions.accept(user, dealId, suggestionId, body);
  }

  @Post(":dealId/competitor-suggestions/:suggestionId/dismiss")
  @HttpCode(200)
  @RequirePermission("crm:deals:update")
  @ResponseSchema(dismissCompetitorSuggestionResponseSchema)
  dismiss(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("suggestionId") suggestionId: string,
    @Body(new ZodValidationPipe(dismissCompetitorSuggestionSchema))
    body: DismissCompetitorSuggestionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.suggestions.dismiss(user, dealId, suggestionId, body);
  }
}
