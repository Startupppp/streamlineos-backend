import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
import { authorize } from "../access/authorize";
import { ActivitiesService } from "../activities/activities.service";
import { AttributionService } from "../attribution/attribution.service";
import { DealsService } from "../deals/deals.service";
import { CAPABILITIES_BY_NAME, CRM_CAPABILITIES } from "./capabilities/crm-capabilities";
import { CrmMcpEnablementService } from "./crm-mcp-enablement.service";
import { CrmMcpGrantsService } from "./crm-mcp-grants.service";
import {
  agentTokenIdOf,
  decideCapabilityAccess,
  narrowTokenScopes,
  type McpRefusal,
} from "./mcp-authorization";
import type { CapabilityServices, McpCapability } from "./mcp-capability";

/**
 * The executor: one protocol call, from a token to a service and back.
 *
 * Phase 6, ticket 19. Everything the ticket asks for that is not a type or a
 * table happens here, in a fixed order, and the order is the argument.
 *
 * **Permissions are resolved through `authorize()`** — the identical function
 * `PermissionGuard` calls for an HTTP route, against the same tables, with the
 * same catalogued-key check and the same module gate. There is no
 * service-account branch, no "internal" bypass, and no path where a capability
 * runs without a decision. The first criterion is met by calling the existing
 * thing rather than by reimplementing it carefully.
 *
 * **The token is scoped before the decision is asked for.** The context this
 * service builds always carries a non-null `tokenScopes`, so
 * `AccessService.scopeFor` denies every key that is not on the token's grant —
 * including for an organisation owner, whose `isOrgOwner` shortcut sits AFTER
 * that check. A token with no grants can do nothing at all, which is what an
 * ungranted machine credential should be able to do.
 *
 * **Nothing an agent sends reaches the decision.** The arguments are parsed
 * inside `capability.invoke`, which is only reached after the decision has been
 * taken. There is no ordering here in which a model, or a prompt, or a cleverly
 * worded field could participate in authorization — the fifth criterion, held by
 * sequence rather than by instruction.
 */

/** What a caller gets back. A refusal is an outcome, not an exception to catch. */
export type McpCallOutcome =
  | { readonly ok: true; readonly capability: string; readonly result: unknown }
  | {
      readonly ok: false;
      readonly capability: string;
      readonly reason: McpRefusal | "invalid-arguments" | "capability-failed";
      readonly message: string;
    };

export interface McpRequestMeta {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly permission: string;
  readonly mutates: boolean;
  readonly arguments: Readonly<Record<string, string>>;
}

@Injectable()
export class CrmMcpService {
  /**
   * The services a capability may reach, assembled once.
   *
   * Held as `CapabilityServices` rather than as three fields, so what a
   * capability can touch is a named type somebody has to widen deliberately
   * rather than a set of things that happen to be in scope. There is no
   * database handle in it and there is nowhere in the type to put one.
   */
  private readonly capabilityServices: CapabilityServices;

  constructor(
    private readonly access: AccessService,
    private readonly enablement: CrmMcpEnablementService,
    private readonly grants: CrmMcpGrantsService,
    private readonly audit: AuditService,
    activities: ActivitiesService,
    deals: DealsService,
    attribution: AttributionService,
  ) {
    this.capabilityServices = { activities, deals, attribution };
  }

  /**
   * The tools this token may actually call.
   *
   * Filtered by the same decision that would refuse the call, rather than
   * listing everything and letting the agent find out. An agent that can see a
   * tool it cannot use spends its turns discovering that, and a list that
   * overstates what a credential holds is a description of the product's
   * permissions that disagrees with the product.
   */
  async listTools(user: CurrentUserContext): Promise<readonly McpToolDescription[]> {
    const decided = await Promise.all(
      CRM_CAPABILITIES.map(async (capability) => ({
        capability,
        decision: await this.decide(user, capability.name),
      })),
    );

    return decided
      .filter((entry) => entry.decision.allow)
      .map((entry) => describe(entry.capability));
  }

  /** Whether the tenant has opened this surface at all. */
  isEnabled(orgId: string): Promise<boolean> {
    return this.enablement.isEnabled(orgId);
  }

  async call(
    user: CurrentUserContext,
    capabilityName: string,
    rawArguments: unknown,
    meta: McpRequestMeta = {},
  ): Promise<McpCallOutcome> {
    const capability = CAPABILITIES_BY_NAME.get(capabilityName);
    const decision = await this.decide(user, capabilityName);

    if (!decision.allow) {
      await this.record(user, capability, capabilityName, meta, {
        result: "FAILURE",
        reason: decision.refusal,
      });
      return {
        ok: false,
        capability: capabilityName,
        reason: decision.refusal,
        message: decision.message,
      };
    }

    /*
      `capability` is defined here because `decide` refuses an unknown name, but
      the compiler cannot see that through the decision type. The alternative —
      a non-null assertion — would be a claim that outlives whoever checked it.
    */
    if (!capability)
      return {
        ok: false,
        capability: capabilityName,
        reason: "unknown-capability",
        message: "No such capability.",
      };

    try {
      const result = await capability.invoke(
        this.capabilityServices,
        {
          orgId: user.orgId,
          userId: user.userId,
          scope: decision.scope,
          actorLabel: `mcp:${user.sessionId}`,
        },
        rawArguments,
      );

      await this.record(user, capability, capabilityName, meta, { result: "SUCCESS" });
      return { ok: true, capability: capabilityName, result };
    } catch (error: unknown) {
      /*
        A failed call is audited too, and audited as the action it attempted.

        The trail exists to answer "what did this token do to my CRM", and an
        attempt that threw halfway through a write is exactly the entry somebody
        will be looking for. Recording only successes would make the log a record
        of the happy path.
      */
      const invalid = error instanceof Error && error.name === "ZodError";
      await this.record(user, capability, capabilityName, meta, {
        result: "FAILURE",
        reason: invalid ? "invalid-arguments" : "capability-failed",
      });

      return {
        ok: false,
        capability: capabilityName,
        reason: invalid ? "invalid-arguments" : "capability-failed",
        message: invalid
          ? "The arguments do not match what this capability accepts."
          : "The capability could not be completed.",
      };
    }
  }

  /**
   * The whole decision, in the order the criteria require it.
   *
   * Enablement, then the credential, then the capability, then the token's
   * grant, then the platform's own answer. Every step reads a fact; none of them
   * reads anything the agent wrote.
   */
  private async decide(user: CurrentUserContext, capabilityName: string) {
    const capability = CAPABILITIES_BY_NAME.get(capabilityName);
    const tokenId = agentTokenIdOf(user.sessionId);

    const serverEnabled = await this.enablement.isEnabled(user.orgId);
    const grantedScopes =
      tokenId === null ? [] : await this.grants.scopesFor(user.orgId, tokenId);

    /*
      The scoped context, and the reason this line is the ticket.

      `AgentTokenGuard` hands over `tokenScopes: null`, which `scopeFor` reads as
      unrestricted — so without this narrowing an agent token would carry its
      owner's entire permission set into every capability. `narrowTokenScopes`
      never returns null and never widens, so the platform's existing check does
      the enforcing and this module adds no second opinion about what is allowed.
    */
    const scoped: CurrentUserContext = {
      ...user,
      tokenScopes: narrowTokenScopes(user.tokenScopes, grantedScopes),
    };

    const authorization = capability
      ? await authorize(this.access, scoped, capability.permission)
      : { allow: false, scope: "none" as const, reason: "FORBIDDEN" as const };

    return decideCapabilityAccess({
      serverEnabled,
      tokenId,
      capability,
      grantedScopes,
      authorization,
    });
  }

  /**
   * One row in `audit_logs`, the same table a human action writes to.
   *
   * `logCritical` rather than `log` everywhere, reads included. The repo's
   * default is best-effort telemetry and it is the wrong default here: "an agent
   * may have read your entire customer list, and we lost the log line" is not an
   * answer anybody can accept, and the read is the action on a protocol surface.
   *
   * Attribution is to the token AND its owner, which is the third criterion.
   * `user_id` is the owner, because the owner is the person accountable for what
   * their credential did; `metadata.agentToken` names the credential, so two
   * tokens belonging to one person are told apart. The action string names the
   * capability, so the trail reads in the same vocabulary as everything else.
   */
  private async record(
    user: CurrentUserContext,
    capability: McpCapability | undefined,
    capabilityName: string,
    meta: McpRequestMeta,
    outcome: { result: "SUCCESS" | "FAILURE"; reason?: string },
  ): Promise<void> {
    await this.audit.logCritical({
      action: capability?.auditAction ?? "crm.mcp.call.rejected",
      userId: user.userId,
      orgId: user.orgId,
      actorUserId: user.userId,
      targetType: "crm_mcp_capability",
      targetId: capabilityName,
      resourceType: "crm_mcp_capability",
      resourceId: capabilityName,
      result: outcome.result,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      requestId: meta.requestId ?? null,
      metadata: {
        moduleKey: "crm",
        protocol: "mcp",
        capability: capabilityName,
        mutates: capability?.mutates ?? false,
        permission: capability?.permission ?? null,
        // The credential, alongside its owner. `sessionId` is `agent-token:<id>`.
        agentToken: user.sessionId,
        ...(outcome.reason ? { refusal: outcome.reason } : {}),
      },
    });
  }
}

function describe(capability: McpCapability): McpToolDescription {
  return {
    name: capability.name,
    description: capability.description,
    permission: capability.permission,
    mutates: capability.mutates,
    arguments: capability.arguments,
  };
}
