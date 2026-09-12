import { SetMetadata } from "@nestjs/common";

export const ALLOW_AGENT_TOKEN = "allowAgentToken";

/**
 * Declares that a route accepts a `slos_` agent token as well as a session.
 *
 * Closed by default and opt-in per surface, which is the whole point. Agent
 * tokens are a non-session credential; every route that does not carry this
 * still answers one with the 401 it answers today, so mounting it here cannot
 * widen anything else by accident.
 *
 * Why this rather than `@UseGuards(AgentTokenGuard)` on the controller: Nest
 * runs global guards before controller guards, so `JwtAuthGuard` (an APP_GUARD)
 * would have refused the credential as unauthenticated before a controller-level
 * `AgentTokenGuard` ever ran — the two would shadow rather than compose. The
 * other way out, `@Public()`, is how `AgentController` escapes the global chain,
 * but it also switches off `MfaGuard` and `ModuleGuard` (both return early on
 * that key) and tells `RouteClassifierGuard` the route is unauthenticated, which
 * would be false. Opting in inside the guard that owns authentication keeps the
 * rest of the chain — admission bucketing by org, MFA policy, module
 * entitlement — running over a real `req.user`.
 */
export const AllowAgentToken = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_AGENT_TOKEN, true);
