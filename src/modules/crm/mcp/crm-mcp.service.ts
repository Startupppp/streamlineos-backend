import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { AccessService, moduleOf } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import type { AuthResult } from "../../access/access.types";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  requiredPermission: string;
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The caller, whole.
 *
 * This was `{ userId: string; orgId: string }`, and that pair is exactly what
 * could not express the thing this surface has to know: *which credential is
 * asking*. `AccessService.scopeFor` clamps an agent or personal token to its
 * own scopes, and it reads that ceiling off `user.principal` — a field the pair
 * did not carry. See `authorizeTool` below.
 */
export type McpContext = CurrentUserContext;

/**
 * CRM MCP Server.
 *
 * Exposes CRM capabilities as MCP tools calling the same Nest services as HTTP,
 * with the exact same permission resolution via AccessService.
 *
 * Hard boundary:
 * - Only CRM-owned capabilities are exposed as tools.
 * - Access to payroll, inventory, or accounting is impossible through this server.
 * - A caller without the required permission is refused with 403 Forbidden.
 */
@Injectable()
export class CrmMcpService {
  private readonly logger = new Logger("CrmMcp");

  constructor(
    private readonly audit: AuditService,
    private readonly accessService: AccessService,
    private readonly partyService: PartyService,
    private readonly dealsService: DealsService,
    private readonly activitiesService: ActivitiesService,
    private readonly reportingService: ReportingService,
    private readonly mcpSettings: CrmMcpSettingsService,
  ) {}

  /** The complete catalogue of CRM MCP tools. */
  readonly tools: McpToolDefinition[] = [
    {
      name: "crm_list_parties",
      description: "List customer and prospect parties in the organization with pagination and search.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search query by name, email or domain" },
          page: { type: "number", description: "Page number (default 1)" },
          limit: { type: "number", description: "Page size (default 20, max 100)" },
          standing: { type: "string", description: "Filter by standing (lead, contact, customer)" },
        },
      },
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_get_party",
      description: "Get detailed information about a single party by partyId.",
      inputSchema: {
        type: "object",
        properties: {
          partyId: { type: "string", description: "The UUID of the party" },
        },
        required: ["partyId"],
      },
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_list_deals",
      description: "List pipeline deals in the organization with stage, pipeline, and assignee filters.",
      inputSchema: {
        type: "object",
        properties: {
          pipelineId: { type: "number", description: "Pipeline ID filter" },
          stageId: { type: "number", description: "Stage ID filter" },
          page: { type: "number", description: "Page number" },
          limit: { type: "number", description: "Items per page (max 100)" },
        },
      },
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_get_deal",
      description: "Get comprehensive details of a single deal by dealId.",
      inputSchema: {
        type: "object",
        properties: {
          dealId: { type: "number", description: "The integer ID of the deal" },
        },
        required: ["dealId"],
      },
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_list_activities",
      description: "List recent CRM activities (calls, emails, meetings, notes) attached to parties or deals.",
      inputSchema: {
        type: "object",
        properties: {
          dealId: { type: "number", description: "Filter by deal ID" },
          page: { type: "number", description: "Page number" },
          limit: { type: "number", description: "Items per page (max 100)" },
        },
      },
      requiredPermission: "crm:activities:view",
    },
    {
      name: "crm_run_report",
      description: "Run an allowlisted CRM report query across parties, deals, or activities with bounded rows.",
      inputSchema: {
        type: "object",
        properties: {
          reportKey: { type: "string", description: "Allowlisted report key" },
          source: { type: "string", description: "Data source (parties, deals, activities)" },
        },
        required: ["source"],
      },
      requiredPermission: "crm:reports:view",
    },
  ];

  /**
   * One answer to "may this caller use this tool", and it is the product's own.
   *
   * `authorize` is what `PermissionGuard` calls for every `@RequirePermission`
   * route: it rejects an uncatalogued key, resolves module entitlement, and
   * then asks `AccessService.scopeFor`, which is where a token's ceiling is
   * applied. This service used to call `resolveUserPermissions(orgId, userId)`
   * instead — the raw membership map, which takes no principal and therefore
   * cannot see a ceiling. A token scoped to `crm:deals:read` got every CRM tool
   * its *issuer* held, here and only here, because every other gated surface in
   * the product goes through `authorize`. That is the same shape of bug as
   * CRM-P1-16 one layer down: two correct halves, no path that crossed them.
   *
   * It also closes a second gap for free. `CrmMcpController` carries no
   * `@RequireModule("crm")` — unlike every other CRM controller — so nothing
   * checked entitlement on this surface. `authorize` resolves it per key.
   */
  private authorizeTool(
    user: McpContext,
    tool: McpToolDefinition,
  ): Promise<AuthResult> {
    return authorize(this.accessService, user, tool.requiredPermission);
  }

  /**
   * Return list of tools available to the caller given what it may do.
   *
   * An organisation that has not switched agent access on gets an empty list
   * rather than a refusal, because that is what the question means: an MCP
   * client is asking what it may call, and the honest answer is nothing. The
   * refusal belongs on the call, where somebody is actually trying to do
   * something — and `executeTool` gives it a distinct message so a scoped-token
   * problem is never mistaken for a switched-off tenant.
   */
  async getAvailableTools(context: McpContext): Promise<McpToolDefinition[]> {
    if (!(await this.mcpSettings.isEnabled(context.orgId))) return [];

    const decisions = await Promise.all(
      this.tools.map((tool) => this.authorizeTool(context, tool)),
    );
    return this.tools.filter((_, index) => decisions[index]?.allow === true);
  }

  /** Execute an MCP tool with full permission and tenant re-assertion. */
  async executeTool(
    context: McpContext,
    call: McpToolCall,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    /**
     * The tenant's own decision, checked before the tool is even resolved.
     *
     * Every other gate here answers "may this caller run this tool". None of
     * them answers whether the organisation wants a machine touching its
     * customer records at all, and a per-tool key cannot express that — an
     * admin holds `crm:deals:read` because they read deals, not because they
     * consented to an agent reading them.
     *
     * Audited, because a call arriving at a switched-off tenant is worth a
     * record: it is either an integration nobody told the operator about or a
     * credential that outlived the decision to stop using it.
     */
    if (!(await this.mcpSettings.isEnabled(context.orgId))) {
      await this.recordToolAudit(context, "crm.mcp.tool_refused", call.name, {
        reason: "AGENT_ACCESS_DISABLED",
        arguments: auditableArguments(call.arguments),
      });
      throw new ForbiddenException(
        "Agent access to the CRM is switched off for this organisation.",
      );
    }

    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      /**
       * Audited before the refusal. An agent asking for a tool that does not
       * exist is a probe, and a probe that leaves no trace is the one worth
       * having a record of.
       */
      await this.recordToolAudit(context, "crm.mcp.tool_unknown", call.name, {
        requestedTool: call.name,
      });
      throw new NotFoundException(`Unknown CRM MCP tool: ${call.name}`);
    }

    const decision = await this.authorizeTool(context, tool);

    if (!decision.allow) {
      await this.recordToolAudit(context, "crm.mcp.tool_refused", tool.name, {
        requiredPermission: tool.requiredPermission,
        reason: decision.reason,
        arguments: auditableArguments(call.arguments),
      });
      /**
       * 402 when the module is off, matching `PermissionGuard`.
       *
       * A 403 here reads as "you lack the permission" and the frontend's
       * EntitlementGate keys its upgrade prompt on 402, so answering the wrong
       * one shows an access-denied dead end where an offer to enable CRM
       * belongs. The refusal a scoped token gets is the 403 below, and the two
       * must stay distinguishable.
       */
      if (decision.reason === "NO_MODULE") {
        throw new ModuleDisabledException(moduleOf(tool.requiredPermission));
      }
      throw new ForbiddenException(
        `Agent lacks required permission '${tool.requiredPermission}' for tool '${tool.name}'`,
      );
    }

    const args = call.arguments || {};
    let result: unknown;

    const anyPartyService = this.partyService as unknown as Record<string, Function>;
    const anyDealsService = this.dealsService as unknown as Record<string, Function>;
    const anyActivitiesService = this.activitiesService as unknown as Record<string, Function>;
    const anyReportingService = this.reportingService as unknown as Record<string, Function>;

    switch (tool.name) {
      case "crm_list_parties": {
        const query = {
          page: typeof args.page === "number" ? args.page : 1,
          limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          query: typeof args.search === "string" ? args.search : undefined,
        };
        if (typeof anyPartyService.list === "function") {
          result = await anyPartyService.list(context.orgId, query);
        } else if (typeof anyPartyService.listParties === "function") {
          result = await anyPartyService.listParties(context.orgId, query);
        }
        break;
      }

      case "crm_get_party": {
        const partyId = String(args.partyId);
        if (!partyId) throw new BadRequestException("partyId is required");
        if (typeof anyPartyService.findOne === "function") {
          result = await anyPartyService.findOne(context.orgId, partyId);
        } else if (typeof anyPartyService.getParty === "function") {
          result = await anyPartyService.getParty(context.orgId, partyId);
        }
        break;
      }

      case "crm_list_deals": {
        const query = {
          page: typeof args.page === "number" ? args.page : 1,
          limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          pipelineId: typeof args.pipelineId === "number" ? args.pipelineId : undefined,
          stageId: typeof args.stageId === "number" ? args.stageId : undefined,
        };
        if (typeof anyDealsService.list === "function") {
          result = await anyDealsService.list(context.orgId, query);
        } else if (typeof anyDealsService.listDeals === "function") {
          result = await anyDealsService.listDeals(context.orgId, context.userId, query, "global");
        }
        break;
      }

      case "crm_get_deal": {
        const dealId = Number(args.dealId);
        if (Number.isNaN(dealId)) throw new BadRequestException("Valid dealId is required");
        if (typeof anyDealsService.findOne === "function") {
          result = await anyDealsService.findOne(context.orgId, dealId);
        } else if (typeof anyDealsService.getDeal === "function") {
          result = await anyDealsService.getDeal(context.orgId, context.userId, dealId, "global");
        }
        break;
      }

      case "crm_list_activities": {
        const query = {
          page: typeof args.page === "number" ? args.page : 1,
          limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          dealId: typeof args.dealId === "number" ? args.dealId : undefined,
        };
        if (typeof anyActivitiesService.list === "function") {
          result = await anyActivitiesService.list(context.orgId, query);
        } else if (typeof anyActivitiesService.timeline === "function") {
          result = await anyActivitiesService.timeline(context.orgId, query);
        }
        break;
      }

      case "crm_run_report": {
        const source = String(args.source || "deals");
        if (typeof anyReportingService.preview === "function") {
          result = await anyReportingService.preview(context.orgId, context.userId, {
            source,
            fields: ["id", "name", "value"],
            limit: 50,
          });
        } else if (typeof anyReportingService.runAdHoc === "function") {
          result = await anyReportingService.runAdHoc(context.orgId, context.userId, {
            source,
            fields: ["id", "name", "value"],
          } as any);
        }
        break;
      }

      default:
        throw new BadRequestException(`Unimplemented tool handler: ${tool.name}`);
    }

    /**
     * CRM-P1-04. Recorded before the result is handed back, and awaited.
     *
     * Every tool here is a read, so the data has already left the database by
     * this point — but it has not left the process, and an unaudited agent read
     * is precisely what this exists to prevent. `logCritical` rather than
     * `log`, so a failure to record surfaces as an error instead of quietly
     * returning the tenant's data with no trace that an agent asked for it.
     *
     * `resultCount` because "the agent read one deal" and "the agent read every
     * deal you have" are the same tool call and very different events.
     */
    await this.recordToolAudit(context, "crm.mcp.tool_executed", tool.name, {
      requiredPermission: tool.requiredPermission,
      arguments: auditableArguments(call.arguments),
      resultCount: countResults(result),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async recordToolAudit(
    context: McpContext,
    action: string,
    toolName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.logCritical({
      action,
      userId: context.userId,
      orgId: context.orgId,
      targetId: toolName,
      targetType: "crm_mcp_tool",
      metadata,
    });
  }
}

/**
 * What of a tool call is safe and useful to keep.
 *
 * Ids, numbers and booleans are kept: they are what makes an entry
 * reconstructable — "read deal 412" rather than "read a deal". Free text is
 * not, because the only string arguments these tools take are search terms,
 * and a tenant's audit log should not accumulate a second copy of everything
 * anybody has ever searched for. Its presence is recorded instead, so a
 * reviewer can see a search happened and how long the term was.
 */
export function auditableArguments(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      /** An id is worth keeping verbatim; a search term is not. */
      out[key] = /^[0-9]+$/.test(value) || UUID.test(value)
        ? value
        : { redacted: true, length: value.length };
      continue;
    }
    if (value === null) out[key] = null;
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How much came back, when that is answerable.
 *
 * The services behind these tools return several shapes — a bare array, a
 * paginated envelope, a single record. Null rather than 0 where it cannot be
 * told, because "one row" and "could not count" must not read the same.
 */
export function countResults(result: unknown): number | null {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const data = (result as { data?: unknown; items?: unknown }).data ??
      (result as { items?: unknown }).items;
    if (Array.isArray(data)) return data.length;
    return 1;
  }
  return result === undefined || result === null ? 0 : 1;
}
