import type { AuthResult, DataScope } from "../access/access.types";
import type { McpCapability } from "./mcp-capability";

/**
 * Whether one protocol call may proceed, decided from facts and nothing else.
 *
 * Phase 6, ticket 19, and the fifth criterion is what shapes this file: AI is
 * barred from the authorization decision path, and that has to be provable
 * structurally rather than promised.
 *
 * Three properties make it provable here.
 *
 * **This function is synchronous.** A model call is a network call and a network
 * call is a promise; a synchronous function cannot await one. Somebody could
 * make it async, but they would have to do it on purpose, in a diff that says
 * so, and `ai-is-barred-from-authorization.spec.ts` fails the moment they do.
 *
 * **It takes an already-decided `AuthResult`.** The permission itself is
 * resolved by `authorize()` — the same call `PermissionGuard` makes for a
 * controller, against the same tables, with no service-account branch and no
 * ambient authority. This file adds refusals; it can never add an allowance the
 * access service did not already give, because `allow: true` is only reachable
 * through `authorization.allow`.
 *
 * **Nothing an agent sent is an input.** The capability's ARGUMENTS are not a
 * parameter. An agent can write anything it likes in a subject line and the
 * decision does not move, because the decision cannot see it.
 *
 * The same spec walks the value-import graph from this file and from
 * `src/modules/access` and fails if any path reaches a model client.
 */

export type McpRefusal =
  | "server-disabled"
  | "not-an-agent-token"
  | "unknown-capability"
  | "out-of-token-scope"
  | "module-disabled"
  | "unauthenticated"
  | "forbidden";

export type McpDecision =
  | { readonly allow: true; readonly scope: DataScope }
  | { readonly allow: false; readonly refusal: McpRefusal; readonly message: string };

export interface McpAccessFacts {
  /** Whether this organisation turned the protocol surface on. Off by default. */
  readonly serverEnabled: boolean;
  /** The token's numeric id, or null when the request did not arrive on one. */
  readonly tokenId: number | null;
  readonly capability: McpCapability | undefined;
  /** The permission keys this specific token was granted. Never "all of them". */
  readonly grantedScopes: readonly string[];
  /** What `authorize()` said, for this capability's permission, for this caller. */
  readonly authorization: AuthResult;
}

export function decideCapabilityAccess(facts: McpAccessFacts): McpDecision {
  /*
    The server being off is checked before anything else, including whether the
    capability exists.

    Order is the argument, as in `send-guardrails.ts`. A tenant who has not
    enabled this must not be able to learn anything through it — including which
    capabilities exist, or whether a name is a real one. Answering
    "unknown capability" to one name and "server disabled" to another is a
    working enumeration oracle on a surface the tenant believes is off.
  */
  if (!facts.serverEnabled)
    return {
      allow: false,
      refusal: "server-disabled",
      message: "The MCP server is not enabled for this organisation.",
    };

  /*
    No token, no call.

    The protocol surface is reachable only with an agent token, and a request
    that arrived some other way has no token to scope, no owner to attribute to
    and nothing to revoke. A session cookie would authenticate perfectly well
    and would be exactly the ambient authority the first criterion forbids.
  */
  if (facts.tokenId === null)
    return {
      allow: false,
      refusal: "not-an-agent-token",
      message: "The MCP surface is reachable only with an agent token.",
    };

  if (!facts.capability)
    return {
      allow: false,
      refusal: "unknown-capability",
      message: "No such capability.",
    };

  /*
    The token's own grant, checked here as well as inside the access service.

    This is not belt and braces. `authorize()` denies an out-of-scope key too —
    it reads the same list off `CurrentUserContext.tokenScopes` — but it reports
    FORBIDDEN, which reads as "the owner lacks this permission" and sends an
    administrator to the wrong screen. The two checks agree by construction
    because they read the same array; this one exists to say WHICH of the two
    ways to be refused happened.
  */
  if (!facts.grantedScopes.includes(facts.capability.permission))
    return {
      allow: false,
      refusal: "out-of-token-scope",
      message: `This token is not scoped for ${facts.capability.permission}.`,
    };

  if (!facts.authorization.allow) {
    if (facts.authorization.reason === "UNAUTHENTICATED")
      return { allow: false, refusal: "unauthenticated", message: "Unauthorized." };
    if (facts.authorization.reason === "NO_MODULE")
      return {
        allow: false,
        refusal: "module-disabled",
        message: "The module this capability belongs to is not available.",
      };
    return {
      allow: false,
      refusal: "forbidden",
      message: `The owner of this token does not hold ${facts.capability.permission}.`,
    };
  }

  return { allow: true, scope: facts.authorization.scope };
}

/**
 * The scopes this call runs under: never wider than either list it comes from.
 *
 * `existing` is whatever the credential already carried — a personal access
 * token brings its own scopes and they still bind. `granted` is what the MCP
 * grant table says this token may use over the protocol. The result is the
 * intersection when both exist, which is the only combination that cannot
 * widen: taking `granted` alone would let an MCP grant hand a personal token a
 * permission its own scope list withheld.
 *
 * It never returns null. Null means "unrestricted" to `AccessService.scopeFor`,
 * and an unrestricted machine credential is the gap this ticket exists to close
 * — a token with no grants gets `[]` and can do nothing, which is the right
 * answer and not an error.
 */
export function narrowTokenScopes(
  existing: readonly string[] | null,
  granted: readonly string[],
): string[] {
  if (existing === null) return [...new Set(granted)];
  const held = new Set(existing);
  return [...new Set(granted.filter((key) => held.has(key)))];
}

/**
 * The token behind a resolved context, or null.
 *
 * `AgentTokenGuard` records the credential as `agent-token:<id>` in `sessionId`
 * and that is, today, the only place the identity survives its own guard: the
 * guard resolves a token to a user context and keeps nothing else. Reading it
 * back out is a seam, not a trick, and it is narrow on purpose — the id is a
 * positive integer or this returns null, so a session id from any other source
 * (`pat:`, a web session) cannot be mistaken for a token.
 *
 * The right end state is a `scopes` column on `agent_tokens` and a guard that
 * populates `tokenScopes` itself, at which point this function and the grant
 * table it feeds both disappear. That change belongs to the token model rather
 * than to this module.
 */
const AGENT_TOKEN_SESSION = /^agent-token:(\d+)$/;

export function agentTokenIdOf(sessionId: string): number | null {
  const match = AGENT_TOKEN_SESSION.exec(sessionId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
