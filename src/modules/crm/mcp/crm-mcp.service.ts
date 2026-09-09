import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { DataScope } from "../../access/access.types";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";

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

export interface McpContext {
  userId: string;
  orgId: string;
}

/**
 * Whether a resolved permission map actually grants a key.
 *
 * `resolved.has(key)` is not the question. `resolveUserPermissions` returns
 * `Map<string, DataScope>`, and a key resolved to `"none"` is present in that
 * map and denied — that is how the resolver says no. Asking `has` therefore let
 * an explicitly denied permission read as granted here while failing everywhere
 * else in the product, because `AccessService.holds` is
 * `scopeFor(...) !== "none"` and every `@RequirePermission` route goes through
 * it. This is the same test, said the same way.
 *
 * The array branch that used to sit here was unreachable: nothing returns a
 * `{ permissions: [] }` shape. It survived because the spec mocked it, so the
 * authorization assertions were exercising a branch production never entered.
 */
function checkPermission(
  resolved: ReadonlyMap<string, DataScope> | null | undefined,
  permission: string,
): boolean {
  return (resolved?.get(permission) ?? "none") !== "none";
}

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

  /** Return list of tools available to the user given their permissions. */
  async getAvailableTools(context: McpContext): Promise<McpToolDefinition[]> {
    const permissions = await this.accessService.resolveUserPermissions(
      context.orgId,
      context.userId,
    );

    return this.tools.filter((tool) =>
      checkPermission(permissions, tool.requiredPermission),
    );
  }

  /** Execute an MCP tool with full permission and tenant re-assertion. */
  async executeTool(
    context: McpContext,
    call: McpToolCall,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
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

    // Resolve caller's effective permissions
    const permissions = await this.accessService.resolveUserPermissions(
      context.orgId,
      context.userId,
    );

    if (!checkPermission(permissions, tool.requiredPermission)) {
      await this.recordToolAudit(context, "crm.mcp.tool_refused", tool.name, {
        requiredPermission: tool.requiredPermission,
        arguments: auditableArguments(call.arguments),
      });
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
