import { SetMetadata } from "@nestjs/common";
import { REQUIRE_PERMISSION } from "../../common/rbac/require-permission-key";

export { REQUIRE_PERMISSION };

/**
 * One key, or several the caller may satisfy any one of.
 *
 * The metadata stays a bare `string` for a single key, and only becomes an array
 * when a route names more than one. Every existing consumer — the BE-30 route
 * classifier, the BE-29 boot sweep, `recordRouteClassification`, the text scans
 * in `src/scripts` — therefore reads exactly what it read before on all but the
 * handful of routes that opt in, and a multi-key route still answers the
 * classifier's `!== undefined` so it cannot become invisible to BE-30.
 *
 * The tuple makes a zero-key call a compile error; the guard denies an empty
 * list at runtime as well, because metadata can also be set by hand.
 */
export const RequirePermission = (...keys: [string, ...string[]]) =>
  SetMetadata(REQUIRE_PERMISSION, keys.length === 1 ? keys[0] : keys);
