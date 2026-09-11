import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CustomerHealthService } from "./customer-health.service";
import {
  customerHealthRosterQuerySchema,
  type CustomerHealthRosterQuery,
} from "./dto/health.schemas";
import {
  customerHealthRosterResponseSchema,
  customerHealthResponseSchema,
  recomputeCustomerHealthResponseSchema,
} from "./dto/health-response.schemas";

/**
 * Customer health, as a surface.
 *
 * Anchored on `partyId` in the path, not a client account id. The health of a
 * customer is a fact about the customer, and every existing surface that keys it
 * on a legacy identifier gives the same merged customer two scores.
 *
 * Two keys, following `lifecycle.controller.ts`. Reading who is unhealthy is a
 * planning question anybody running a book asks; recomputing writes an
 * assessment, replaces its factor rows and overwrites
 * `business_parties.health_score` — which is what a dozen other screens render —
 * so it is a different authority to hand out.
 *
 * The keys are literals at each gate rather than a hoisted constant.
 * `gated-keys-are-catalogued.spec.ts` reads decorators with a regex and cannot
 * resolve a constant, so a gate written that way is one the catalogue check
 * silently does not cover.
 */
@RequireModule("crm")
@Controller("crm/customer-health")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CustomerHealthController {
  constructor(private readonly health: CustomerHealthService) {}

  /**
   * The roster, worst first. `?unscored=true` is the other half of it: the
   * customers the model could not answer for, who appear on no band-filtered
   * screen precisely because they have no band.
   */
  @Get()
  @RequirePermission("crm:customer-health:view")
  @ResponseSchema(customerHealthRosterResponseSchema)
  roster(
    @Query(new ZodValidationPipe(customerHealthRosterQuerySchema))
    query: CustomerHealthRosterQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.health.roster(u.orgId, query);
  }

  /**
   * One customer's score WITH the inputs that produced it — every factor, its
   * declared weight, the weight it actually carried, the window it was measured
   * over, and for a missing input the reason it is missing rather than a value
   * standing in for one.
   */
  @Get(":partyId")
  @RequirePermission("crm:customer-health:view")
  @ResponseSchema(customerHealthResponseSchema)
  get(@Param("partyId") partyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.health.get(u.orgId, partyId);
  }

  /**
   * Recomputes from the sources. A POST because it writes: the assessment, its
   * factor rows, and the score projected onto the party record.
   *
   * Deliberately not folded into the GET. A read that recomputes is a read a
   * refresh loop turns into a write loop, and it would mean two people looking
   * at the same customer this afternoon could see different numbers with nothing
   * recording why.
   */
  @Post(":partyId/recompute")
  @BodylessAction()
  @RequirePermission("crm:customer-health:manage")
  @ResponseSchema(recomputeCustomerHealthResponseSchema)
  recompute(@Param("partyId") partyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.health.assess(u.orgId, partyId);
  }
}
