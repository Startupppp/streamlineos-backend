import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuthContextFactory } from "../../common/auth/auth-context.factory";
import { authorize } from "../access/authorize";
import { AccessService } from "../access/access.service";
import { compileQuery, type CompiledQuery } from "./compiler/compile";
import { QueryCompilationError } from "./compiler/errors";
import type { QueryDescription } from "./compiler/query-description";
import { REPORTING_REGISTRY } from "./compiler/registry";
import type { RequesterScope } from "./compiler/scope";
import { REPORTING_RUN, type HeldPermissions } from "./reporting-source-access";

@Injectable()
export class ReportingAuthService {
  constructor(
    private readonly access: AccessService,
    private readonly authContexts: AuthContextFactory,
  ) {}

  /**
   * May this caller run this source — checked the same way `PermissionGuard`
   * and every CRM MCP tool check anything: through `authorize`, against the
   * caller's own `CurrentUserContext`.
   *
   * This used to call `heldPermissions` — a bare `resolveUserPermissions(orgId,
   * userId)` lookup with no principal, so no ceiling. For a `human-session`
   * caller that is invisible: a JWT principal's ceiling is unbounded, so
   * `authorize` resolves to exactly what `resolveUserPermissions` already
   * returned and this is a no-op change for the HTTP controller. For an
   * `agent-token` principal it is the whole bug: `context.userId` on an agent
   * token is the *issuing human's* id, so the bare lookup returned that human's
   * full permission set regardless of what the token itself was scoped to. An
   * MCP token minted with only `crm:reports:view` could run `crm_run_report`
   * against `parties`/`deals`/`activities` with its issuer's full
   * `crm:reporting:run` authority, because nothing here ever asked what the
   * token itself was allowed to do. `authorize` is where a ceiling is applied
   * (`AccessService.scopeFor`'s `agent-token` branch), so routing both checks
   * through it closes that gap without opening a new one for the human path.
   *
   * Two keys, checked in the same order `decideSourceAccess` checked them, so
   * the exceptions this throws are unchanged: `REPORTING_RUN` first — a caller
   * who may not run reports at all learns that before anything about the
   * source — then the source's own governing key, once the source is known to
   * exist. An unregistered source is still a 400: no permission would grant it,
   * so calling it forbidden would send the caller to an administrator who
   * cannot help.
   */
  async assertMayRunSource(user: CurrentUserContext, sourceKey: string): Promise<void> {
    /*
     * `authorize` takes an `AuthContext`, not the bare `CurrentUserContext`
     * every caller here actually holds — the HTTP controller's `@CurrentUser()`,
     * the CRM MCP service's principal, and the cron consumer's synthesized
     * "human-session" user are all just the actor. `AuthContextFactory.create`
     * needs no live request: its lookups (module availability, membership,
     * MFA) are ordinary injectable services, so building it here is exactly
     * what `CrmMcpService.executeTool` already does before its own `authorize`
     * call, and it is what lets an agent token's ceiling reach this check —
     * `scopeFor`'s agent-token branch lives behind `AuthContext`, not before it.
     */
    const authCtx = this.authContexts.create(user);
    const runDecision = await authorize(this.access, authCtx, REPORTING_RUN);
    if (!runDecision.allow)
      throw new ForbiddenException(`this report requires ${REPORTING_RUN}`);

    const source = REPORTING_REGISTRY.get(sourceKey);
    if (!source)
      throw new BadRequestException(`no queryable source named ${JSON.stringify(sourceKey)}`);

    const sourceDecision = await authorize(this.access, authCtx, source.requiredPermission);
    if (!sourceDecision.allow)
      throw new ForbiddenException(`this report requires ${source.requiredPermission}`);
  }

  compileOrThrow(
    query: QueryDescription,
    orgId: string,
    requester: RequesterScope,
  ): CompiledQuery {
    try {
      return compileQuery(query, { organizationId: orgId, requester });
    } catch (error) {
      if (error instanceof QueryCompilationError)
        throw new BadRequestException({
          message: error.message,
          code: error.code,
          path: error.path,
        });
      throw error;
    }
  }

  async heldPermissions(orgId: string, userId: string): Promise<HeldPermissions> {
    const resolved = await this.access.resolveUserPermissions(orgId, userId);
    return new Set(resolved.keys());
  }

  /**
   * The scope the compiler applies, resolved from the grant that admits the run.
   *
   * This closes `REPORTING_SCOPE_GAP`. Ticket 10 kept the keys and dropped the
   * scope, and recorded that a narrowed grant was being treated as a full one.
   * Ticket 11 is the ticket that stops that being true, and the shape of the fix
   * is the whole point: the scope is resolved HERE and handed to the compiler,
   * which applies it on the way out. A description cannot opt out of a predicate
   * it never supplies.
   *
   * `REPORTING_RUN` is the grant consulted, not the narrowest of everything the
   * user holds. Scope is per key, and the key that admits this operation is the
   * one whose scope governs it — taking a minimum across unrelated keys would
   * let an unrelated narrow grant silently restrict reporting, which is a
   * different rule nobody stated.
   *
   * Absent means `none`, not `all`. A user whose grant has gone while their
   * session lives sees nothing rather than everything, which is the direction a
   * scope resolution has to fail in. Resolved through `authorize` for the same
   * reason `assertMayRunSource` is: an agent token's ceiling must narrow this
   * scope too, or a token scoped to `own` deals could still total the whole
   * pipeline once the admission check above passed.
   */
  async requesterScope(user: CurrentUserContext): Promise<RequesterScope> {
    const decision = await authorize(this.access, this.authContexts.create(user), REPORTING_RUN);
    return { userId: user.userId, scope: decision.allow ? decision.scope : "none" };
  }
}
