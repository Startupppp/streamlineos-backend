import type { ZodType } from "zod";
import type { DataScope } from "../access/access.types";
import type { ActivitiesService } from "../activities/activities.service";
import type { AttributionService } from "../attribution/attribution.service";
import type { DealsService } from "../deals/deals.service";

/**
 * What a capability is allowed to reach, and what it is structurally denied.
 *
 * Phase 6, ticket 19. The fourth criterion — the protocol layer never reaches
 * past the service boundary — is the one that is normally violated within a
 * month, and never by anyone acting in bad faith. It is violated because one
 * capability needs a field the service does not return, the database handle is
 * three lines away, and the reviewer is looking at a six-line diff.
 *
 * So there is no database handle three lines away. `CapabilityServices` names
 * services and nothing else, every one of them a type-only import, and the
 * whole capability layer therefore has no VALUE import that reaches `DRIZZLE`
 * — it holds no schema symbols, no query builder, and nothing to build one
 * from. `capabilities-cannot-reach-the-database.spec.ts` walks the value-import
 * graph from the catalogue and fails if any path arrives at one.
 *
 * That is the same trick `query-compiler.ts` plays with tenancy: a report cannot
 * opt out of its organisation because there is nowhere in the type to say so.
 * A capability cannot reach past a service because there is nothing in scope to
 * reach with.
 *
 * The consequence is deliberate and is the ticket's own instruction: where a
 * capability needs something no service does, the SERVICE is extended or built
 * first. There is no shortcut here to take.
 */
export interface CapabilityServices {
  readonly activities: ActivitiesService;
  readonly deals: DealsService;
  readonly attribution: AttributionService;
}

/**
 * Who the call is being made as.
 *
 * `scope` comes back from the access service's own decision, not from anything
 * the caller sent, so a capability that narrows a read by scope narrows it by
 * the same value a controller would have been handed.
 */
export interface CapabilityCaller {
  readonly orgId: string;
  readonly userId: string;
  readonly scope: DataScope;
  /**
   * What a record this call writes says did it — `mcp:token:<id>`.
   *
   * Given to the capability rather than derived by it, so a capability can stamp
   * the token onto a row without being able to reason about which token it is.
   * A capability that could tell one token from another could behave differently
   * for one, which is the shape of every backdoor anybody has ever shipped.
   */
  readonly actorLabel: string;
}

/**
 * One thing an agent can do, and the permission it is done under.
 *
 * `permission` is a key from the platform's existing catalogue, never a new one
 * minted for the protocol. That is the first criterion: an agent holding
 * `crm:deals:read` reads deals over MCP exactly as far as it reads them over
 * HTTP, and enabling the protocol surface grants nobody anything they did not
 * already have. `capabilities-are-catalogued.spec.ts` — in effect the same
 * check `gated-keys-are-catalogued.spec.ts` performs for `@RequirePermission` —
 * holds it.
 */
export interface McpCapability {
  /** What the protocol calls this tool. Stable: an agent may have it written down. */
  readonly name: string;
  readonly description: string;
  /** A catalogued permission key. Resolved through `authorize`, exactly as a route is. */
  readonly permission: string;
  /** Whether invoking it changes anything. Read in the audit trail and by the client. */
  readonly mutates: boolean;
  /** The `audit_logs.action` this call writes. Same table and vocabulary as a human's. */
  readonly auditAction: string;
  /** Describes the arguments for `tools/list`. Prose, because that is what an agent reads. */
  readonly arguments: Readonly<Record<string, string>>;
  readonly invoke: (
    services: CapabilityServices,
    caller: CapabilityCaller,
    rawArguments: unknown,
  ) => Promise<unknown>;
}

/**
 * Builds a capability whose `invoke` validates before it runs.
 *
 * The schema is closed over rather than exposed, so `invoke` is not generic and
 * the catalogue can be a plain frozen array — and, more usefully, so a
 * capability cannot be added that forgets to parse its arguments. Everything an
 * agent sends arrives as `unknown` and becomes typed in exactly one place.
 */
export function defineCapability<Input>(spec: {
  readonly name: string;
  readonly description: string;
  readonly permission: string;
  readonly mutates: boolean;
  readonly auditAction: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly schema: ZodType<Input>;
  readonly run: (
    services: CapabilityServices,
    caller: CapabilityCaller,
    input: Input,
  ) => Promise<unknown>;
}): McpCapability {
  return {
    name: spec.name,
    description: spec.description,
    permission: spec.permission,
    mutates: spec.mutates,
    auditAction: spec.auditAction,
    arguments: spec.arguments,
    invoke: (services, caller, rawArguments) =>
      spec.run(services, caller, spec.schema.parse(rawArguments)),
  };
}
