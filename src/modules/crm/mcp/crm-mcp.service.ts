import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { AccessService } from "../../access/access.service";
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

function checkPermission(resolved: unknown, permission: string): boolean {
  if (!resolved) return false;
  if (resolved instanceof Map) {
    return resolved.has(permission) || resolved.has("*");
  }
  if (typeof resolved === "object" && "permissions" in resolved) {
    const list = (resolved as { permissions?: unknown }).permissions;
    if (Array.isArray(list)) {
      return list.includes(permission) || list.includes("*");
    }
  }
  return false;
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
      requiredPermission: "crm:deals:view",
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
      requiredPermission: "crm:deals:view",
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
      throw new NotFoundException(`Unknown CRM MCP tool: ${call.name}`);
    }

    // Resolve caller's effective permissions
    const permissions = await this.accessService.resolveUserPermissions(
      context.orgId,
      context.userId,
    );

    if (!checkPermission(permissions, tool.requiredPermission)) {
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
}
