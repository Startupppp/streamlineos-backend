import { ForbiddenException } from "@nestjs/common";
import type { AccessService } from "../../../access/access.service";

/**
 * C2 — the one key that lets replenishment raise a purchase order.
 *
 * Every path from a proposal to a draft order goes through here. Not because
 * `@RequirePermission` is unreliable, but because it is *detachable*: it lives
 * on the controller, and `PermissionGuard` is not global (backend §2), so a new
 * route added next to the existing ones is authenticated and module-gated and
 * silently un-permissioned. The decorator states the rule at the edge; this
 * states it where the purchase order is actually created, which is the place a
 * new caller cannot route around.
 */
export const PURCHASE_ORDER_CREATE_PERMISSION = "inventory:purchase-orders:create";

/**
 * Throws unless this member may create purchase orders in this organisation.
 *
 * `resolveUserPermissions` is the same resolution `PermissionGuard` performs —
 * cached per `(userId, orgId)` and busted by `bumpPermissionsVersion` — so this
 * is a second reading of the same authority, not a parallel one that could
 * disagree with it. An org owner or org admin resolves to the whole catalog, so
 * the map carries the key for them too.
 */
export async function assertMayCreatePurchaseOrder(
  access: AccessService,
  orgId: string,
  userId: string,
): Promise<void> {
  const permissions = await access.resolveUserPermissions(orgId, userId);
  if (!permissions.has(PURCHASE_ORDER_CREATE_PERMISSION)) {
    // The caller is inside the right tenant and lacks the permission, which is
    // the one case §4 reserves a 403 for.
    throw new ForbiddenException(
      "Raising a purchase order needs inventory:purchase-orders:create.",
    );
  }
}
