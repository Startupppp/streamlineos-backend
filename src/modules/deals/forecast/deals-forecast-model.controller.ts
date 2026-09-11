import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ForecastTrainingService } from "./forecast-training.service";

/**
 * The three questions a tenant can ask about their own forecast model.
 *
 * What is the number on screen (`model`), fit one now (`train`), and why does
 * this deal score what it scores (`deals/:dealId`).
 *
 * `train` is a POST because it writes, and it is gated on `crm:deals:manage`
 * rather than `crm:deals:forecast` on purpose: reading a forecast and replacing
 * the arithmetic behind everybody's pipeline total are different authorities.
 * It returns the verdict either way — a run that fitted a model and then refused
 * to store it is a successful request, and the response says which gate it
 * failed, because "we tried and it was not good enough" is information the
 * tenant is owed and silence is not.
 */
@RequireModule("crm")
@Controller("deals/forecast")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsForecastModelController {
  constructor(private readonly forecast: ForecastTrainingService) {}

  @Get("model")
  @RequirePermission("crm:deals:forecast")
  getModel(@CurrentUser() u: CurrentUserContext) {
    return this.forecast.describeBasis(u.orgId);
  }

  @Post("train")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("crm:deals:manage")
  train(@CurrentUser() u: CurrentUserContext) {
    return this.forecast.train(u.orgId);
  }

  /**
   * One deal's stored score and the factors behind it.
   *
   * Null when this organisation has no learned model, or when the deal has not
   * been scored under the current one — a closed deal, a deal created since the
   * last pass, or a tenant on the naive arm. The surface renders the weighted
   * arithmetic in every one of those cases, which is what it was already
   * rendering.
   */
  @Get("deals/:dealId")
  @RequirePermission("crm:deals:read")
  async getDealScore(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    /**
     * Wrapped, because "no score" is a normal answer and a bare `null` body is
     * not reliably distinguishable from an empty one by the time it has been
     * through the response envelope and the client's unwrap. An object with a
     * null field says the same thing and survives the trip.
     */
    return { score: await this.forecast.scoreForDeal(u.orgId, dealId) };
  }
}
