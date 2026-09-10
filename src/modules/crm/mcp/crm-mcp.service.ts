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
import { listPartiesQuerySchema } from "../../party/dto/party.schemas";
import { listDealsSchema } from "../../deals/dto/deals.schemas";
import { timelineQuerySchema } from "../../activities/dto/activity.schemas";
import {
  asQueryDescription,
  queryDescriptionSchema,
} from "../../reporting/dto/reporting.schemas";

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
 * The scope the resolver answered for a key, which is also its answer to
 * whether the key is held at all.
 *
 * `resolveUserPermissions` returns `Map<string, DataScope>`, and a key resolved
 * to `"none"` is present in that map and denied — that is how the resolver says
 * no. So there is one reading here, not two: the scope is the decision, and
 * `checkPermission` below is that same value asked as a yes/no.
 */
function scopeOf(
  resolved: ReadonlyMap<string, DataScope> | null | undefined,
  permission: string,
): DataScope {
  return resolved?.get(permission) ?? "none";
}

/**
 * Whether a resolved permission map actually grants a key.
 *
 * `resolved.has(key)` is not the question, for the reason above: asking `has`
 * let an explicitly denied permission read as granted here while failing
 * everywhere else in the product, because `AccessService.holds` is
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
  return scopeOf(resolved, permission) !== "none";
}

/**
 * What each report source returns to an agent.
 *
 * Fixed per source and named from `REPORTING_REGISTRY`, the closed set the
 * compiler resolves against — a name absent from it is refused at compile time
 * rather than becoming a column. An agent chooses the source; it does not name
 * columns, because inventing a field name here is exactly how the previous
 * version failed: it asked for `["id", "name", "value"]` on every source, and
 * not one of those three is a field of any of them.
 *
 * A `Map`, for the reason `REPORTING_REGISTRY` is one: `source` is a string the
 * caller chose, and looking it up in a plain object reaches the prototype —
 * `"__proto__"` returns `Object.prototype` and `"constructor"` returns a
 * function, both truthy, so the `if (!select)` below would treat them as found.
 * Zod refuses the description a step later either way, so the old shape failed
 * closed; it failed closed with a shape error about a source that does not
 * exist, instead of saying which sources do.
 */
const MCP_REPORT_PROJECTIONS: ReadonlyMap<string, { kind: "field"; field: string }[]> =
  new Map([
    [
      "parties",
      [
        { kind: "field" as const, field: "name" },
        { kind: "field" as const, field: "party_type" },
        { kind: "field" as const, field: "status" },
      ],
    ],
    [
      "deals",
      [
        { kind: "field" as const, field: "name" },
        { kind: "field" as const, field: "stage" },
        { kind: "field" as const, field: "value_minor" },
      ],
    ],
    [
      "activities",
      [
        { kind: "field" as const, field: "kind" },
        { kind: "field" as const, field: "subject" },
        { kind: "field" as const, field: "occurred_at" },
      ],
    ],
  ]);

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
          search: { type: "string", description: "Search by name, legal name or email" },
          page: { type: "number", description: "Page number (default 1)" },
          limit: { type: "number", description: "Page size (default 20, max 100)" },
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
      description: "List pipeline deals in the organization with stage and assignee filters.",
      inputSchema: {
        type: "object",
        properties: {
          stage: { type: "string", description: "Filter by pipeline stage" },
          assignedToId: { type: "string", description: "Filter to one owner's deals" },
          offset: { type: "number", description: "Rows to skip (default 0)" },
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
      description:
        "Read the activity timeline (calls, emails, meetings, notes) for one party or one deal. An anchor is required.",
      inputSchema: {
        type: "object",
        properties: {
          partyId: { type: "string", description: "Anchor: the party whose timeline to read" },
          dealId: { type: "number", description: "Anchor: the deal whose timeline to read" },
          kind: { type: "string", description: "Filter by activity kind" },
          cursor: { type: "string", description: "Opaque cursor from the previous page" },
          limit: { type: "number", description: "Items per page (default 25, max 100)" },
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
          source: { type: "string", description: "Data source: parties, deals or activities" },
          limit: { type: "number", description: "Row cap (default 50, max 1000)" },
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

    /**
     * The caller's own DataScope, not the string `"global"` this used to pass.
     *
     * `"global"` is not a member of `DataScope`, so `applyScope` fell through to
     * its exhaustive default and emitted a `false` predicate: `crm_list_deals`
     * answered every agent with an EMPTY LIST, silently, because an empty deals
     * result is indistinguishable from an organisation that has no deals. The
     * check above has already established this is not `"none"`.
     */
    const scope = scopeOf(permissions, tool.requiredPermission);

    const args = call.arguments || {};
    let result: unknown;

    /*
     * The four services are called directly, with their real types. That is the
     * fix here, not a tidy-up.
     *
     * This block used to cast each one to `Record<string, Function>` and probe
     * it — `if (typeof svc.list === "function") … else if (typeof svc.listParties
     * === "function")`. No service has a `list`, a `findOne` or a `preview`, so
     * every first branch was dead and only the fallbacks ever ran; and because
     * the cast erased the signatures, nothing checked what the fallbacks were
     * handed. Every handler disagreed with the service it called, and the file
     * compiled clean:
     *
     *   crm_list_parties     sent `query`; the schema and the service read
     *                        `search`, so an agent's search term was dropped and
     *                        every call returned page one of everything.
     *   crm_list_deals       sent `page`, `pipelineId` and `stageId`; the input
     *                        has `offset` and `stage` and no notion of a
     *                        pipeline — three of its four advertised filters did
     *                        nothing, and paging was impossible.
     *   crm_get_deal         passed `(orgId, userId, dealId, "global")` to a
     *                        method that takes `(orgId, dealId)`, so the deal id
     *                        it read was the caller's user id.
     *   crm_list_activities  sent `page` to a keyset timeline that pages on
     *                        `cursor`, and could pass no anchor at all, which
     *                        falls through to `subject_id = ''` and matches
     *                        nothing.
     *   crm_get_party        did `String(args.partyId)` and then tested the
     *                        result for emptiness. `String(undefined)` is
     *                        `"undefined"`, which is truthy, so a missing id was
     *                        looked up as that literal string instead of refused.
     *   crm_run_report       sent `fields` where the description takes `select`,
     *                        naming fields that are in no source's registry, and
     *                        omitted the required `limit` — three independent
     *                        errors under one erased signature. It answered 400
     *                        to every call ever made to it.
     *
     * Arguments are parsed by each module's own Zod schema rather than re-coerced
     * by hand here, which is what stops the two surfaces drifting apart again:
     * the bounds an agent gets are the bounds the HTTP route enforces, including
     * the page cap and the timeline's "a timeline is read for a party, a deal or
     * a subject" rule. A ZodError raised here maps to 400 in AllExceptionsFilter,
     * so a malformed tool call is refused rather than quietly reinterpreted.
     */
    switch (tool.name) {
      case "crm_list_parties": {
        const query = listPartiesQuerySchema.parse({
          page: args.page ?? 1,
          limit: args.limit ?? 20,
          ...(args.search === undefined ? {} : { search: args.search }),
        });
        result = await this.partyService.listParties(context.orgId, query);
        break;
      }

      case "crm_get_party": {
        const partyId = typeof args.partyId === "string" ? args.partyId.trim() : "";
        if (!partyId) throw new BadRequestException("partyId is required");
        result = await this.partyService.getParty(context.orgId, partyId);
        break;
      }

      case "crm_list_deals": {
        const query = listDealsSchema.parse({
          limit: args.limit ?? 20,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.stage === undefined ? {} : { stage: args.stage }),
          ...(args.assignedToId === undefined ? {} : { assignedToId: args.assignedToId }),
        });
        result = await this.dealsService.listDeals(
          context.orgId,
          context.userId,
          query,
          scope,
        );
        break;
      }

      case "crm_get_deal": {
        /*
         * `getDeal(orgId, dealId)` on this branch — two parameters, and no
         * DataScope among them.
         *
         * That is not an omission here: reading one deal by id does not honour
         * the caller's scope anywhere in this lane, HTTP included, because the
         * method has nowhere to put it. `crm/phase-2-3-consolidated` widened it
         * to `(orgId, userId, dealId, scope)` in `7b35e781e`, which is a
         * separate change to `DealsService` and every one of its callers. What
         * *is* fixed here is that the old call passed four arguments to this
         * two-parameter method, so `dealId` received `context.userId` and the
         * tool read a deal by the caller's user id.
         */
        const dealId = Number(args.dealId);
        if (!Number.isInteger(dealId) || dealId < 1)
          throw new BadRequestException("Valid dealId is required");
        result = await this.dealsService.getDeal(context.orgId, dealId);
        break;
      }

      case "crm_list_activities": {
        /*
         * The anchor is required, and that is the timeline's own rule rather
         * than one invented here — `timelineQuerySchema` refines on it. Without
         * one the service's anchor falls to `subject_id = ''`, which matches
         * nothing, so an unanchored call returned an empty page that reads as
         * "this deal has no activity". Refusing says what actually happened.
         */
        const query = timelineQuerySchema.parse({
          limit: args.limit ?? 25,
          ...(args.partyId === undefined ? {} : { partyId: args.partyId }),
          ...(args.dealId === undefined ? {} : { dealId: args.dealId }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        });
        result = await this.activitiesService.timeline(context.orgId, query);
        break;
      }

      case "crm_run_report": {
        const source = typeof args.source === "string" ? args.source : "";
        const select = MCP_REPORT_PROJECTIONS.get(source);
        if (!select)
          throw new BadRequestException(
            `Unknown report source '${source}'. Valid sources: ${[...MCP_REPORT_PROJECTIONS.keys()].join(", ")}.`,
          );
        const query = queryDescriptionSchema.parse({
          source,
          select,
          limit: args.limit ?? 50,
        });
        result = await this.reportingService.runAdHoc(
          context.orgId,
          context.userId,
          asQueryDescription(query),
        );
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
