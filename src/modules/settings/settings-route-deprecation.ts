/**
 * The sunset date every `/settings/*` alias shares.
 *
 * Global `/settings/*` holds organization configuration and access governance
 * only (root CLAUDE.md §8); a module-owned surface belongs to its module. The
 * routes carrying this date are the ones that moved, kept at the old path only
 * so a shipped client keeps working across one release. A single constant
 * rather than a date repeated per handler, because a window that drifts per
 * route is not a window.
 *
 * `@Deprecated` is what makes the promise observable: `DeprecationInterceptor`
 * returns `Deprecation: true` plus this `Sunset` and a `Link` to the canonical
 * path, and `recordRouteClassification` stamps `deprecated: true` and
 * `x-sunset` onto the operation, so the document and the response agree.
 */
export const SETTINGS_ALIAS_SUNSET = "2027-03-31";
