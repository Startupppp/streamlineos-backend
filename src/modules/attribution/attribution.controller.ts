import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ATTRIBUTION_MODELS,
  ATTRIBUTION_MODEL_VERSION,
  attributionModelSummary,
} from "./attribution-models";
import { AttributionService } from "./attribution.service";
import {
  attributionForDealQuerySchema,
  attributionReportQuerySchema,
  type AttributionForDealQuery,
  type AttributionReportQueryInput,
} from "./dto/attribution.schemas";

/*
  The key is written out at each route rather than held in a constant.

  A shared constant reads better and `gated-keys-are-catalogued.spec.ts` cannot
  resolve one: its scan reads the decorator's literal, counts the ones it cannot,
  and fails when that count grows. A gate the catalogue guard cannot see is a
  gate that can name a key nobody catalogued and never be caught, which is worth
  more than the tidiness.

  `crm:reports:view` throughout — attribution is a reading of revenue, and it is
  gated exactly as every other revenue report is.
*/

@Controller("crm/attribution")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  /**
   * What the model picker offers, and what each model means.
   *
   * Served rather than hard-coded in the client for the second criterion's
   * sake: the caption a figure carries and the list a user chooses from are the
   * same strings from the same file, so a model whose arithmetic changes cannot
   * keep an out-of-date description on the screen that renders it.
   */
  @Get("models")
  @RequirePermission("crm:reports:view")
  models() {
    return {
      modelVersion: ATTRIBUTION_MODEL_VERSION,
      models: ATTRIBUTION_MODELS.map((model) => ({
        model,
        summary: attributionModelSummary(model),
      })),
    };
  }

  @Get("deals/:dealId")
  @RequirePermission("crm:reports:view")
  forDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Query(new ZodValidationPipe(attributionForDealQuerySchema)) query: AttributionForDealQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attribution.forDeal(user.orgId, dealId, query.model);
  }

  @Get("report")
  @RequirePermission("crm:reports:view")
  report(
    @Query(new ZodValidationPipe(attributionReportQuerySchema))
    query: AttributionReportQueryInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attribution.report(user.orgId, {
      model: query.model,
      from: new Date(query.from),
      to: new Date(query.to),
    });
  }
}
