import { Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
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
 * **Sweeps every organisation, not the caller's.** `forEachOrg` is the only way
 * a background job can discover work under RLS, and the endpoint is therefore
 * platform maintenance rather than a tenant action — which is why it needs
 * `inventory:settings:manage` and returns a count rather than a payload.
 */
@RequireModule("inventory")
@Controller("inventory/maintenance")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvExpirySweepController {
  constructor(private readonly sweep: InvExpirySweepService) {}

  @Post("expiry-sweep")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  run() {
    return this.sweep.sweep();
  }
}
