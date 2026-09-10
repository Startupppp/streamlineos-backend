import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { AccessService } from "../../access/access.service";
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
 * The shape `executeTool` casts each injected service to so it can probe it for
 * a method name.
 *
 * It was `Record<string, Function>`, which `no-unsafe-function-type` bans and
 * should: `Function` carries no call signature at all, so every probed call
 * took `any[]` and handed back `any`. Nothing below was checked. A real
 * signature restores the only two things the probe can honestly promise — the
 * value is callable, and what comes back is `unknown` and must be narrowed
 * before it is used. It is also what removes the `as any` that sat on the
 * report query: that cast existed only to satisfy a parameter `Function` had
 * already erased.
 *
 * **What this does NOT fix, recorded here rather than in a commit message so
 * the next reader of the switch sees it.** `list`, `findOne` and `preview`
 * exist on none of the four services — `PartyService` has
 * `listParties`/`getParty`, `DealsService` `listDeals`/`getDeal`,
 * `ActivitiesService` `timeline`, `ReportingService` `runAdHoc` — so every
 * first branch below is dead and only the fallback beneath it ever runs. The
 * fallbacks are unchecked too: `getDeal` really takes `(orgId, dealId)`, and
 * the call below passes `(orgId, userId, dealId, "global")`, so the deal id it
 * reads is the caller's user id. `crm-mcp.service.spec.ts` builds its doubles
 * from the dead names, which is why the suite is green over a branch
 * production never enters — a double shaped from the caller can only confirm
 * the caller.
 *
 * The fix is to call the injected services directly with their real types,
 * which turns each of the above into a compile error. That was done on
 * `crm/phase-2-3-consolidated` in `f6d572780`, along with the spec rewrite it
 * requires; it is a behaviour change across six tools and does not belong in a
 * lint pass on this branch.
 */
type ProbedService = Record<string, (...args: unknown[]) => unknown>;

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

    const probedPartyService = this.partyService as unknown as ProbedService;
    const probedDealsService = this.dealsService as unknown as ProbedService;
    const probedActivitiesService = this.activitiesService as unknown as ProbedService;
    const probedReportingService = this.reportingService as unknown as ProbedService;

    switch (tool.name) {
      case "crm_list_parties": {
        const query = {
          page: typeof args.page === "number" ? args.page : 1,
          limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          query: typeof args.search === "string" ? args.search : undefined,
        };
        if (typeof probedPartyService.list === "function") {
          result = await probedPartyService.list(context.orgId, query);
        } else if (typeof probedPartyService.listParties === "function") {
          result = await probedPartyService.listParties(context.orgId, query);
        }
        break;
      }

      case "crm_get_party": {
        const partyId = String(args.partyId);
        if (!partyId) throw new BadRequestException("partyId is required");
        if (typeof probedPartyService.findOne === "function") {
          result = await probedPartyService.findOne(context.orgId, partyId);
        } else if (typeof probedPartyService.getParty === "function") {
          result = await probedPartyService.getParty(context.orgId, partyId);
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
        if (typeof probedDealsService.list === "function") {
          result = await probedDealsService.list(context.orgId, query);
        } else if (typeof probedDealsService.listDeals === "function") {
          result = await probedDealsService.listDeals(context.orgId, context.userId, query, "global");
        }
        break;
      }

      case "crm_get_deal": {
        const dealId = Number(args.dealId);
        if (Number.isNaN(dealId)) throw new BadRequestException("Valid dealId is required");
        if (typeof probedDealsService.findOne === "function") {
          result = await probedDealsService.findOne(context.orgId, dealId);
        } else if (typeof probedDealsService.getDeal === "function") {
          result = await probedDealsService.getDeal(context.orgId, context.userId, dealId, "global");
        }
        break;
      }

      case "crm_list_activities": {
        const query = {
          page: typeof args.page === "number" ? args.page : 1,
          limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          dealId: typeof args.dealId === "number" ? args.dealId : undefined,
        };
        if (typeof probedActivitiesService.list === "function") {
          result = await probedActivitiesService.list(context.orgId, query);
        } else if (typeof probedActivitiesService.timeline === "function") {
          result = await probedActivitiesService.timeline(context.orgId, query);
        }
        break;
      }

      case "crm_run_report": {
        const source = String(args.source || "deals");
        if (typeof probedReportingService.preview === "function") {
          result = await probedReportingService.preview(context.orgId, context.userId, {
            source,
            fields: ["id", "name", "value"],
            limit: 50,
          });
        } else if (typeof probedReportingService.runAdHoc === "function") {
          result = await probedReportingService.runAdHoc(context.orgId, context.userId, {
            source,
            fields: ["id", "name", "value"],
          });
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
