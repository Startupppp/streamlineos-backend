import { SetMetadata } from "@nestjs/common";

export const IS_UNIVERSAL = "is_universal";

/**
 * Marks a route as available to every authenticated, active member without a
 * specific permission key.  The route still requires a valid JWT — it is NOT
 * public.  Use this only for surfaces that §8 of CLAUDE.md designates as
 * platform core (home, mail, chat, notifications, own profile, people directory
 * reads, internal job listings).
 *
 * Every route that carries neither @Public(), @Universal(), nor
 * @RequirePermission() is treated as undeclared and is denied by
 * RouteClassifierGuard.
 */
export const Universal = () => SetMetadata(IS_UNIVERSAL, true);
