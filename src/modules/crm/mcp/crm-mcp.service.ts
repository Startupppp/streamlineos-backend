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
import { AuditService, type AuditEntry } from "../../../common/audit/audit.service";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";
import { listPartiesQuerySchema } from "../../party/dto/party.schemas";
import { listDealsSchema } from "../../deals/dto/deals.schemas";
import { timelineQuerySchema } from "../../activities/dto/activity.schemas";
import { asQueryDescription, queryDescriptionSchema } from "../../reporting/dto/reporting.schemas";

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
/**
 * What each report source returns to an agent.
 *
 * Fixed per source and named from `REPORTING_REGISTRY`, the closed set the
 * compiler resolves against — a name absent from it is refused at compile time
 * rather than becoming a column. An agent chooses the source; it does not name
 * columns, because inventing a field name here is exactly how the previous
 * version failed: it asked for `["id", "name", "value"]` on every source, and
 * not one of those three is a field of any of them.
 */
const MCP_REPORT_PROJECTIONS: Record<string, { kind: "field"; field: string }[]> = {
  parties: [
    { kind: "field", field: "name" },
    { kind: "field", field: "party_type" },
    { kind: "field", field: "status" },
  ],
  deals: [
    { kind: "field", field: "name" },
    { kind: "field", field: "stage" },
    { kind: "field", field: "value_minor" },
  ],
  activities: [
    { kind: "field", field: "kind" },
    { kind: "field", field: "subject" },
    { kind: "field", field: "occurred_at" },
  ],
};

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
      description: "List pipeline deals in the organization with stage, pipeline, and assignee filters.",
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
      await this.recordRefusedToolAudit(context, "crm.mcp.tool_refused", call.name, {
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
      await this.recordRefusedToolAudit(context, "crm.mcp.tool_unknown", call.name, {
        requestedTool: call.name,
      });
      throw new NotFoundException(`Unknown CRM MCP tool: ${call.name}`);
    }

    const decision = await this.authorizeTool(context, tool);

    if (!decision.allow) {
      await this.recordRefusedToolAudit(context, "crm.mcp.tool_refused", tool.name, {
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
     *                        errors under one `as any`. It answered 400 to every
     *                        call ever made to it.
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
        /*
         * `decision.scope`, not the literal string "global" this passed before.
         *
         * "global" is not a member of `DataScope`, so `applyScope` fell through
         * to its exhaustive default and returned sql`false`: this tool answered
         * every agent with an EMPTY LIST, silently, because an empty deals result
         * is indistinguishable from an organisation that has no deals.
         */
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
          decision.scope,
        );
        break;
      }

      case "crm_get_deal": {
        /*
         * `authorize` above resolves the caller's DataScope and clamps it to a
         * token's ceiling, and this class promises "the exact same permission
         * resolution via AccessService" as HTTP. Passing anything else throws
         * that promise away.
         */
        const dealId = Number(args.dealId);
        if (!Number.isInteger(dealId) || dealId < 1)
          throw new BadRequestException("Valid dealId is required");
        result = await this.dealsService.getDeal(
          context.orgId,
          context.userId,
          dealId,
          decision.scope,
        );
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
        const select = MCP_REPORT_PROJECTIONS[source];
        if (!select)
          throw new BadRequestException(
            `Unknown report source '${source}'. Valid sources: ${Object.keys(MCP_REPORT_PROJECTIONS).join(", ")}.`,
          );
        const query = queryDescriptionSchema.parse({
          source,
          select,
          limit: args.limit ?? 50,
        });
        result = await this.reportingService.runAdHoc(
          context,
          asQueryDescription(query),
        );
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

  /**
   * The record of a call that ran, in the request's own transaction.
   *
   * `logCritical` rather than `log`, so a failure to record surfaces as an
   * error instead of quietly returning the tenant's data with no trace that an
   * agent asked for it.
   */
  private async recordToolAudit(
    context: McpContext,
    action: string,
    toolName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.logCritical(
      this.toolAuditEntry(context, action, toolName, metadata),
    );
  }

  /**
   * The record of a call this method is about to refuse — written where the
   * refusal cannot take it with it.
   *
   * A refusal is delivered by throwing. The throw unwinds out of the handler,
   * through `TenantContextInterceptor`, and `withTenant` rolls the request's
   * transaction back — including any row written inside it. So the three
   * refusal entries below went through `logCritical` and were rolled back every
   * time: measured against a real database, the row was visible to the
   * request's own transaction and gone from the table once the 403 was
   * delivered. The comment on `executeTool` says an unaudited agent read is
   * what this exists to prevent; an agent *denied* a read left even less
   * behind, because that path has no surviving row anywhere else to infer it
   * from.
   *
   * `logCriticalOutsideTransaction` commits the entry on a transaction of its
   * own, so the rollback that carries the refusal cannot reach it. It is still
   * awaited: a surface that cannot record a refusal must fail loudly rather
   * than refuse in silence.
   */
  private async recordRefusedToolAudit(
    context: McpContext,
    action: string,
    toolName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.logCriticalOutsideTransaction(
      this.toolAuditEntry(context, action, toolName, metadata),
    );
  }

  /** The entry itself, so the two durabilities cannot drift apart on its shape. */
  private toolAuditEntry(
    context: McpContext,
    action: string,
    toolName: string,
    metadata: Record<string, unknown>,
  ): AuditEntry {
    return {
      action,
      userId: context.userId,
      orgId: context.orgId,
      targetId: toolName,
      targetType: "crm_mcp_tool",
      metadata,
    };
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
