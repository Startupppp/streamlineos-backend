import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ColdOutboundAdminService } from "./cold-outbound-admin.service";
import {
  registerSendingDomainSchema,
  setColdTrackSchema,
  type RegisterSendingDomainInput,
  type SetColdTrackInput,
} from "./dto/cold-outbound.schemas";
import {
  coldOutboundOverviewResponseSchema,
  registerSendingDomainResponseSchema,
  verifySendingDomainResponseSchema,
  startWarmupResponseSchema,
  setColdTrackResponseSchema,
  resumeColdTrackResponseSchema,
} from "./dto/cold-outbound-response.schemas";

/**
 * The switches `evaluateColdGate` reads, which until now nothing could reach.
 *
 * The gate refuses cold sends on `not-enabled` and on the absence of a warmed
 * sending domain, and both live in tables no endpoint wrote: the only writer of
 * `crm_cold_outbound_settings` in the whole codebase was the send path's own
 * `pauseColdTrack`, which only ever writes `enabled: false`. So the track could
 * pause itself and never be enabled, warmed or resumed. These routes are the
 * missing half.
 *
 * Its own controller rather than routes on `OutboundController`, because that
 * one is the door a message goes through and this one is the door the feature
 * goes through. Mixing them would put "start a campaign" one line from "turn the
 * campaign machinery on".
 *
 * Behind `crm:autonomy:manage` throughout, including the read: the overview
 * carries the DNS token that proves domain ownership, and the pause reason,
 * which is a deliverability incident. Neither is something the `view` key —
 * which exists so a salesperson can watch the decision feed — should open.
 */
@Controller("crm/autonomy/cold-outbound")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ColdOutboundAdminController {
  constructor(private readonly cold: ColdOutboundAdminService) {}

  @Get()
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(coldOutboundOverviewResponseSchema)
  overview(@CurrentUser() u: CurrentUserContext) {
    return this.cold.overview(u.orgId);
  }

  /**
   * Idempotent because the unique indexes would otherwise turn a retried timeout
   * into a 409 on a domain the caller did in fact register.
   */
  @Post("domains")
  @Idempotent("crm.autonomy.cold-domain-register")
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(registerSendingDomainResponseSchema)
  registerDomain(
    @Body(new ZodValidationPipe(registerSendingDomainSchema)) body: RegisterSendingDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cold.registerDomain(u.orgId, body);
  }

  /**
   * A POST rather than a GET despite reading DNS, because it writes `verified_at`
   * on success. Not idempotent-keyed: re-checking a domain whose record has just
   * gone live is the normal way to use this, and a replayed "not published yet"
   * would strand the tenant on a stale answer.
   */
  @Post("domains/:sendingDomainId/verify")
  @BodylessAction()
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(verifySendingDomainResponseSchema)
  verifyDomain(
    @Param("sendingDomainId") sendingDomainId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cold.verifyDomain(u.orgId, sendingDomainId);
  }

  @Post("domains/:sendingDomainId/warmup")
  @BodylessAction()
  @Idempotent("crm.autonomy.cold-domain-warmup")
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(startWarmupResponseSchema)
  startWarmup(
    @Param("sendingDomainId") sendingDomainId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cold.startWarmup(u.orgId, sendingDomainId);
  }

  /** One route for both directions, so the off switch can never go missing. */
  @Post("track")
  @Idempotent("crm.autonomy.cold-track-set")
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(setColdTrackResponseSchema)
  setTrack(
    @Body(new ZodValidationPipe(setColdTrackSchema)) body: SetColdTrackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return body.enabled
      ? this.cold.enable(u.orgId, u.userId)
      : this.cold.disable(u.orgId, u.userId);
  }

  /**
   * Separate from enabling, because a pause and an off switch are different
   * states and collapsing them would let "turn it back on" quietly clear a
   * deliverability halt the tenant never read.
   */
  @Post("resume")
  @BodylessAction()
  @Idempotent("crm.autonomy.cold-track-resume")
  @RequirePermission("crm:autonomy:manage")
  @ResponseSchema(resumeColdTrackResponseSchema)
  resume(@CurrentUser() u: CurrentUserContext) {
    return this.cold.resume(u.orgId, u.userId);
  }
}
