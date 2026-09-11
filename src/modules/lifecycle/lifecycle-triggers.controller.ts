import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { LifecycleTriggersService } from "./lifecycle-triggers.service";
import {
  listTriggersQuerySchema,
  sweepTriggersSchema,
  type ListTriggersQuery,
  type SweepTriggersQuery,
} from "./dto/triggers.schemas";

/**
 * The door that starts a renewal sweep, and the log of what it did.
 *
 * There is no route here that sends anything, forces a class, or skips the hold
 * — for the same reason `OutboundController` has none. Everything this surface
 * can cause happens behind `OutboundService.composeAndHold`, under its hold
 * window and its guardrails, and a route that reached past them would make the
 * one safeguard on an unrecallable action optional for whoever knew about it.
 *
 * Two keys, and the split is not the usual view/manage. `run` is the write, and
 * what it writes is not a row: it opens opportunities in the pipeline, spends
 * the tenant's AI credits, and starts hold windows that end in mail leaving the
 * building unless somebody cancels them. That is a materially larger authority
 * than editing a record, and folding it into `crm:lifecycle:manage` — which a
 * renewals administrator plainly needs — would hand it to everybody who files a
 * signal.
 *
 * The keys are written out as literals at each gate rather than hoisted into
 * constants: `gated-keys-are-catalogued.spec.ts` reads the decorators with a
 * regex and cannot resolve a constant, so a gate expressed that way is one the
 * catalogue check silently does not cover.
 */
@RequireModule("crm")
@Controller("crm/lifecycle-triggers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LifecycleTriggersController {
  constructor(private readonly triggers: LifecycleTriggersService) {}

  /**
   * What fired, why, and what the outbound loop answered.
   *
   * This is the accountable surface of the feature. The decision ledger records
   * that a message was drafted; only this says which renewal it was for and
   * which renewals produced nothing — and the refusals are the half a person
   * needs, because a contract the loop keeps declining to write about is a
   * contract somebody has to write about themselves.
   */
  @Get()
  @RequirePermission("crm:lifecycle-triggers:view")
  list(
    @Query(new ZodValidationPipe(listTriggersQuerySchema)) query: ListTriggersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.triggers.list(u.orgId, query);
  }

  /**
   * Consider the renewal book and hand what is due to the outbound loop.
   *
   * Idempotent, because a retried POST must not become a second sweep. The
   * once-per-term claim already stops a duplicate opportunity and the re-offer
   * interval already stops a duplicate draft, but both of those are per contract
   * — a client retrying a timeout would otherwise walk the whole book a second
   * time and pay for whatever the first pass had not yet reached.
   */
  @Post("sweep")
  @Idempotent("crm.lifecycle.trigger-sweep")
  @RequirePermission("crm:lifecycle-triggers:run")
  sweep(
    @Body(new ZodValidationPipe(sweepTriggersSchema)) body: SweepTriggersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.triggers.sweep(u.orgId, body);
  }

  /**
   * The same decision for one contract.
   *
   * It runs the identical decider rather than forcing the conversation open, so
   * this is "look at this one now", not "override". A caller who wants a renewal
   * conversation the decider stands down on is asking for a message, and the
   * honest way to send one of those is to write it.
   */
  @Post(":customerLifecycleId/consider")
  @BodylessAction()
  @Idempotent("crm.lifecycle.trigger-consider")
  @RequirePermission("crm:lifecycle-triggers:run")
  consider(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.triggers.consider(u.orgId, customerLifecycleId);
  }
}
