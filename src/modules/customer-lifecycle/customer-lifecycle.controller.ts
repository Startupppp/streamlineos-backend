import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { CustomerLifecycleService } from "./customer-lifecycle.service";
import { RenewalTriggerService } from "./renewal-trigger.service";
import {
  listLifecyclesQuerySchema,
  listSignalsQuerySchema,
  type ListLifecyclesQuery,
  type ListSignalsQuery,
} from "./dto/customer-lifecycle.schemas";

/**
 * One controller for a record type, not a module of bespoke screens.
 *
 * `GET record-types` serves the layout description and every read returns rows
 * keyed to match it, so a surface renders the list, the detail view and the form
 * through the Phase 1 renderer with nothing written for any of them. That is
 * ticket 07's second criterion, and the reason there is no
 * `customer-lifecycle-list.controller.ts` beside this one.
 *
 * The keys are written out at each gate rather than through a constant, which
 * looks like duplication and is not: `gated-keys-are-catalogued.spec.ts` reads
 * the decorators to prove every key a route is gated on exists in the
 * catalogue, and a gate it cannot read is a gate it cannot check. Two authorities
 * for the same reason `customer-executive` has them — reading which customers
 * are about to leave is a different grant from opening opportunities against
 * them on their account manager's behalf.
 *
 * The two writes are sweeps rather than record edits, and neither creates
 * anything a person could not: `sync` gives a lifecycle to closed-won deals that
 * have none, and `triggers/sweep` opens renewal opportunities in the tenant's own
 * pipeline. Both are safe to run twice — the second pass sees the lifecycle and
 * the open opportunity the first one made — and both still carry `@Idempotent`,
 * which requires the caller to send a key. That is not belt and braces: what a
 * repeat is safe against is a repeat, and two sweeps running CONCURRENTLY both
 * read "no open opportunity" before either writes one. The unique index closes
 * that window for a lifecycle and there is no index that can close it for a
 * deal, so the replay guard is the only thing standing between a retry storm and
 * a tenant's forecast counting the same renewal twice.
 */
@RequireModule("crm")
@Controller("crm/customer-lifecycles")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CustomerLifecycleController {
  constructor(
    private readonly lifecycles: CustomerLifecycleService,
    private readonly triggers: RenewalTriggerService,
  ) {}

  /**
   * The description.
   *
   * Declared before `:customerLifecycleId` so the literal path wins the match —
   * a record whose identifier is "record-types" is not a risk worth a second
   * route prefix, but route order is.
   */
  @Get("record-types")
  @RequirePermission("crm:clients:read")
  recordTypes() {
    return { customer_lifecycle: this.lifecycles.layout() };
  }

  @Get()
  @RequirePermission("crm:clients:read")
  list(
    @Query(new ZodValidationPipe(listLifecyclesQuerySchema)) query: ListLifecyclesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycles.list(u.orgId, query.limit);
  }

  @Get(":customerLifecycleId")
  @RequirePermission("crm:clients:read")
  get(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycles.get(u.orgId, customerLifecycleId);
  }

  /** The accumulated history, for a surface that wants it without the record. */
  @Get(":customerLifecycleId/signals")
  @RequirePermission("crm:clients:read")
  signals(
    @Param("customerLifecycleId") customerLifecycleId: string,
    @Query(new ZodValidationPipe(listSignalsQuerySchema)) query: ListSignalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycles.signals(u.orgId, customerLifecycleId, query.limit);
  }

  @Post("sync")
  @Idempotent("crm.customer-lifecycles.sync")
  @RequirePermission("crm:clients:update")
  async sync(@CurrentUser() u: CurrentUserContext) {
    return { opened: await this.lifecycles.openFromClosedWonDeals(u.orgId) };
  }

  @Post("triggers/sweep")
  @Idempotent("crm.customer-lifecycles.trigger-sweep")
  @RequirePermission("crm:clients:update")
  sweep(@CurrentUser() u: CurrentUserContext) {
    return this.triggers.sweep(u.orgId);
  }
}
