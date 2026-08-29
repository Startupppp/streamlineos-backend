import { Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvExpirySweepService } from "./inv-expiry-sweep.service";

/**
 * G3 — the trigger the sweep was missing.
 *
 * The sweep was written, registered and tested, and nothing called it. That is
 * the same shape as the unreachable features `inventory-reachability.spec.ts`
 * exists to catch, and it caught this one — in code committed an hour earlier as
 * "done". A sweep with no trigger notifies nobody.
 *
 * Modelled on `POST /inventory/settings/maintenance/expire-reservations`, which
 * is how the other periodic job in this module is exposed: an operator-callable
 * endpoint that an external scheduler can also hit. That is the established
 * convention here — there is no `@nestjs/schedule` in this repo and inventing a
 * scheduler for one sweep would be a larger change than the sweep itself.
 *
 * **Sweeps the caller's organisation only.** `forEachOrg` is how the scheduler
 * variant discovers work across tenants under RLS, but that is not a thing a
 * tenant-scoped permission may trigger — see the handler.
 */
@RequireModule("inventory")
@Controller("inventory/maintenance")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvExpirySweepController {
  constructor(private readonly sweep: InvExpirySweepService) {}

  /**
   * Sweeps **the caller's organisation**, and only that one.
   *
   * The first version called the all-tenant sweep from here, which was a
   * cross-tenant hole: `inventory:settings:manage` is a tenant-scoped
   * permission, so any one organisation's inventory administrator could have
   * driven work and written `inventory.lot.expiring` events into organisations
   * they have no relationship with — and the `{ organizations }` count in the
   * response disclosed the size of the platform on its own. The endpoint it was
   * modelled on, `settings/maintenance/expire-reservations`, passes `u.orgId`
   * for exactly this reason and the copy dropped it.
   *
   * The all-tenant sweep still exists for a scheduler, and is deliberately not
   * reachable over HTTP.
   */
  @Post("expiry-sweep")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  run(@CurrentUser() u: CurrentUserContext) {
    return this.sweep.sweepOrg(u.orgId);
  }
}
