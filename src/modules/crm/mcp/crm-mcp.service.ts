import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { namespaceOf } from "../../../common/rbac/module-vocabulary";
import { authorize } from "../../access/authorize";
import type { AuthResult } from "../../access/access.types";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { AuditService, type AuditEntry } from "../../../common/audit/audit.service";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";
import {
  crmMcpToolCatalogue,
  type McpContext,
  type McpToolCall,
  type McpToolDefinition,
} from "./lib/crm-mcp-tool-catalogue";
import { runCrmMcpTool } from "./lib/crm-mcp-tool-handlers";
import { mcpToolScopedRead } from "./lib/crm-mcp-scope";
import { auditableArguments, countResults } from "./lib/crm-mcp-audit-arguments";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";

export type { McpContext, McpToolCall, McpToolDefinition } from "./lib/crm-mcp-tool-catalogue";
export { auditableArguments, countResults } from "./lib/crm-mcp-audit-arguments";

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
    private readonly authContexts: AuthContextFactory,
  ) {}

  /** The complete catalogue of CRM MCP tools. */
  readonly tools: McpToolDefinition[] = crmMcpToolCatalogue();

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
    return authorize(this.accessService, this.authContexts.create(user), tool.requiredPermission);
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
        throw new ModuleDisabledException(
          namespaceOf(tool.requiredPermission),
          decision.moduleReason ?? "org-disabled",
        );
      }
      throw new ForbiddenException(
        `Agent lacks required permission '${tool.requiredPermission}' for tool '${tool.name}'`,
      );
    }

    /**
     * The caller's own scope, not the string `"global"` this used to pass.
     *
     * `"global"` is not a member of `DataScope`, so `applyScope` fell through to
     * its exhaustive default and emitted a `false` predicate: `crm_list_deals`
     * answered every agent with an EMPTY LIST, silently, because an empty deals
     * result is indistinguishable from an organisation that has no deals. The
     * check above has already established this is not `"none"`.
     *
     * Built here, by this surface's resolver, so the scope reaches a handler as
     * a `ScopedRead` and never as the string behind it — ADR 0005.
     */
    const read = mcpToolScopedRead(context, decision);

    const args = call.arguments || {};

    /*
     * Each tool's handler, and the record of what every one of them used to get
     * wrong, is `runCrmMcpTool` in `lib/crm-mcp-tool-handlers.ts`. It is handed
     * that read, so the scope a deal query is narrowed by is the one `authorize`
     * resolved above.
     */
    const result = await runCrmMcpTool(
      {
        partyService: this.partyService,
        dealsService: this.dealsService,
        activitiesService: this.activitiesService,
        reportingService: this.reportingService,
      },
      context,
      tool,
      read,
      args,
    );

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
