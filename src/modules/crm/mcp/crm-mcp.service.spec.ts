import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmMcpService, type McpContext } from "./crm-mcp.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";
import { isCoreModuleKey } from "../../../common/rbac/module-registry";
import { agentTokenPrincipal, humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";

describe("CrmMcpService", () => {
  let service: CrmMcpService;
  let audit: { logCritical: jest.Mock };
  let mcpSettings: { isEnabled: jest.Mock };
  let accessService: {
    scopeFor: jest.Mock;
    getModuleState: jest.Mock;
    buildModuleAvailabilityResolver: jest.Mock;
  };
  let partyService: { list: jest.Mock; findOne: jest.Mock };
  let dealsService: { list: jest.Mock; findOne: jest.Mock };
  let activitiesService: { list: jest.Mock };
  let reportingService: { preview: jest.Mock };

  /**
   * A real caller, not `{ userId, orgId }`.
   *
   * The pair was the whole of `McpContext` and is exactly what could not carry
   * a principal, so nothing downstream could tell an interactive session from a
   * scoped token. `scopeFor` reads the ceiling off `principal`; a context
   * without one cannot be clamped.
   */
  const context: McpContext = {
    userId: "usr_agent_123",
    orgId: "org_crm_test",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess_1",
    tokenScopes: null,
    principal: humanSessionPrincipal(11, false),
  };

  /** What `AccessService.scopeFor` will answer, per key. */
  function grantScopes(entries: ReadonlyArray<[string, DataScope]>): void {
    const map = new Map<string, DataScope>(entries);
    accessService.scopeFor.mockImplementation(
      async (_user: McpContext, key: string) => map.get(key) ?? "none",
    );
  }

  beforeEach(async () => {
    accessService = {
      /**
       * The seam, mocked; the ceiling logic behind it is not re-implemented
       * here. `scopeFor` is where a token's scopes clamp the answer, and a
       * mock that reproduced that clamp would be asserting against itself.
       * The real clamp is proven end to end in
       * `crm-mcp-agent-token.seeded-e2e-spec.ts` against a real AccessService.
       */
      scopeFor: jest.fn().mockResolvedValue("none" satisfies DataScope),
      /** CRM is enabled unless a test says otherwise. */
      getModuleState: jest.fn().mockResolvedValue(true),
      buildModuleAvailabilityResolver: jest.fn(
        (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) => ({
          /**
           * The real predicate, not `() => false`.
           *
           * `party` is a namespace the CRM module administers, not a registered
           * module, so production answers true for it and party keys are never
           * plan-gated. A double that hardcoded false would have made the test
           * below assert the opposite of what ships.
           */
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getUserDeniedModules: async () => new Set<string>(),
          getPlanLockedModules: async () => [] as readonly string[],
        }),
      ),
    };
    partyService = {
      list: jest.fn(),
      findOne: jest.fn(),
    };
    dealsService = {
      list: jest.fn(),
      findOne: jest.fn(),
    };
    activitiesService = {
      list: jest.fn(),
    };
    reportingService = {
      preview: jest.fn(),
    };

    audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    mcpSettings = { isEnabled: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmMcpService,
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: accessService },
        { provide: PartyService, useValue: partyService },
        { provide: DealsService, useValue: dealsService },
        { provide: ActivitiesService, useValue: activitiesService },
        { provide: ReportingService, useValue: reportingService },
        /**
         * Agent access is on unless a test says otherwise.
         *
         * CRM-P2-09 added a tenant switch in front of every tool. Defaulting
         * the double to off would have turned every assertion in this file into
         * a test of the switch instead of a test of what it guards.
         */
        { provide: CrmMcpSettingsService, useValue: mcpSettings },
      ],
    }).compile();

    service = module.get<CrmMcpService>(CrmMcpService);
  });

  describe("tool enumeration and boundaries", () => {
    it("exposes only CRM-owned tools, not payroll or inventory", () => {
      const toolNames = service.tools.map((t) => t.name);
      expect(toolNames).toContain("crm_list_parties");
      expect(toolNames).toContain("crm_get_party");
      expect(toolNames).toContain("crm_list_deals");
      expect(toolNames).toContain("crm_get_deal");
      expect(toolNames).toContain("crm_list_activities");
      expect(toolNames).toContain("crm_run_report");

      // Verify no payroll or inventory tools exist
      expect(toolNames.some((n) => n.includes("payroll"))).toBe(false);
      expect(toolNames.some((n) => n.includes("stock"))).toBe(false);
      expect(toolNames.some((n) => n.includes("inventory"))).toBe(false);
    });

    it("filters available tools based on the caller's actual permissions", async () => {
      // User only has deals read permission
      grantScopes([["crm:deals:read", "all"]]);

      const available = await service.getAvailableTools(context);
      const names = available.map((t) => t.name);

      expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
      expect(names).not.toContain("crm_list_parties");
      expect(names).not.toContain("crm_run_report");
    });
  });

  describe("tool execution and authorization", () => {
    it("allows deal listing when caller has crm:deals:read", async () => {
      grantScopes([["crm:deals:read", "all"]]);
      dealsService.list.mockResolvedValue({
        items: [{ id: 1, name: "Big Enterprise Deal" }],
        total: 1,
      });

      const result = await service.executeTool(context, {
        name: "crm_list_deals",
        arguments: { page: 1, limit: 20 },
      });

      expect(dealsService.list).toHaveBeenCalledWith("org_crm_test", {
        page: 1,
        limit: 20,
        pipelineId: undefined,
        stageId: undefined,
      });
      expect(result.content[0].text).toContain("Big Enterprise Deal");
    });

    it("refuses deal listing with 403 Forbidden when caller lacks crm:deals:read", async () => {
      grantScopes([["party:parties:view", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_list_deals",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.list).not.toHaveBeenCalled();
    });

    /**
     * The resolver says no by returning `"none"`, not by leaving the key out.
     *
     * This check once asked `resolved.has(key)`, which is true for a key
     * resolved to `"none"` — so a permission the resolver had explicitly denied
     * read as granted here, and only here. Both that bug and its fix are now
     * `authorize`'s to own: it refuses any key whose scope resolves `"none"`,
     * which is the same test every `@RequirePermission` route applies.
     */
    it("refuses a permission the resolver denied by scope rather than by absence", async () => {
      grantScopes([["crm:deals:read", "none"]]);

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: {} }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.list).not.toHaveBeenCalled();
    });

    it("refuses party listing with 403 Forbidden when caller lacks party:parties:view", async () => {
      grantScopes([["crm:deals:read", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_list_parties",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(partyService.list).not.toHaveBeenCalled();
    });

    it("throws NotFoundException on unknown tools", async () => {
      grantScopes([["*", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "payroll_post_run",
          arguments: {},
        }),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * CRM-P1-04. Every one of these tools reads a tenant's customer data, and
     * `executeTool` used to write nothing at all — an agent could list parties,
     * deals, activities and reports leaving no record it had been there.
     */
    it("records what the agent read, and how much of it", async () => {
      grantScopes([["party:parties:view", "all"]]);
      partyService.list.mockResolvedValue({ data: [{ id: "p1" }, { id: "p2" }] });

      await service.executeTool(context, {
        name: "crm_list_parties",
        arguments: { limit: 20, search: "acme corp" },
      });

      expect(audit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "crm.mcp.tool_executed",
          orgId: "org_crm_test",
          targetId: "crm_list_parties",
          targetType: "crm_mcp_tool",
          metadata: expect.objectContaining({
            requiredPermission: "party:parties:view",
            /** Two rows, not "a list" — the size is most of the signal. */
            resultCount: 2,
            /** The search term itself is not copied into the audit log. */
            arguments: { limit: 20, search: { redacted: true, length: 9 } },
          }),
        }),
      );
    });

    it("records a refusal, which is the entry a reviewer most wants", async () => {
      grantScopes([]);

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: { limit: 5 } }),
      ).rejects.toThrow(ForbiddenException);

      expect(audit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "crm.mcp.tool_refused",
          targetId: "crm_list_deals",
        }),
      );
    });

    it("records an agent asking for a tool that does not exist", async () => {
      /** A probe that leaves no trace is the one worth having a record of. */
      await expect(
        service.executeTool(context, { name: "payroll_post_run", arguments: {} }),
      ).rejects.toThrow(NotFoundException);

      expect(audit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "crm.mcp.tool_unknown",
          metadata: expect.objectContaining({ requestedTool: "payroll_post_run" }),
        }),
      );
    });

    /**
     * If any tool named a key the catalogue does not contain, `authorize`
     * would refuse it before looking at anything else and every assertion in
     * this file would pass while proving nothing.
     */
    it("names catalogued permission keys, so a refusal cannot be the uncatalogued-key rule", () => {
      const catalogue = new Set(ALL_PERMISSION_NAMES);
      for (const tool of service.tools) {
        expect(catalogue.has(tool.requiredPermission)).toBe(true);
      }
    });

    /**
     * The drift catcher for CRM-P1-16's second half.
     *
     * Authorization here has to run over the caller, principal and all. The
     * previous implementation asked `resolveUserPermissions(orgId, userId)`,
     * which takes no principal and so could not see a token's ceiling — a
     * change back to it would still satisfy every "refuses without the
     * permission" test above, because a session holds the same keys either
     * way. Only this assertion notices.
     */
    it("authorizes over the caller's principal, not a bare userId and orgId", async () => {
      const agent: McpContext = {
        ...context,
        sessionId: "agent-token:9",
        tokenScopes: ["crm:deals:read"],
        principal: agentTokenPrincipal(11, 9, ["crm:deals:read"]),
      };
      grantScopes([["crm:deals:read", "all"]]);
      dealsService.list.mockResolvedValue({ items: [] });

      await service.executeTool(agent, { name: "crm_list_deals", arguments: {} });

      expect(accessService.scopeFor).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: expect.objectContaining({
            kind: "agent-token",
            ceiling: ["crm:deals:read"],
          }),
        }),
        "crm:deals:read",
      );
    });

    /**
     * 402, not 403, when CRM is off.
     *
     * `CrmMcpController` carries no `@RequireModule("crm")` — unlike every
     * other CRM controller — so before authorization moved to `authorize`
     * nothing on this surface checked entitlement at all. The frontend's
     * EntitlementGate keys its upgrade prompt on 402, and a 403 would show an
     * access-denied dead end where an offer to enable CRM belongs.
     */
    it("answers 402 rather than 403 when the CRM module is disabled", async () => {
      grantScopes([["crm:deals:read", "all"]]);
      accessService.getModuleState.mockResolvedValue(false);

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: {} }),
      ).rejects.toBeInstanceOf(ModuleDisabledException);

      expect(dealsService.list).not.toHaveBeenCalled();
    });

    it("hides every module-gated tool from the catalogue when CRM is disabled", async () => {
      grantScopes([
        ["crm:deals:read", "all"],
        ["party:parties:view", "all"],
      ]);
      accessService.getModuleState.mockResolvedValue(false);

      const names = (await service.getAvailableTools(context)).map((t) => t.name);

      expect(names).not.toContain("crm_list_deals");
      /**
       * `party:` is a namespace the CRM module administers, not a registered
       * module of its own, so `isCoreModuleKey("party")` is true and party
       * tools are not plan-gated. Same answer any `@RequirePermission
       * ("party:parties:view")` route gives.
       */
      expect(names).toContain("crm_list_parties");
    });

    it("executes crm_get_party with caller's orgId", async () => {
      grantScopes([["party:parties:view", "all"]]);
      partyService.findOne.mockResolvedValue({
        id: "pty_123",
        name: "Acme Corp",
      });

      const result = await service.executeTool(context, {
        name: "crm_get_party",
        arguments: { partyId: "pty_123" },
      });

      expect(partyService.findOne).toHaveBeenCalledWith("org_crm_test", "pty_123");
      expect(result.content[0].text).toContain("Acme Corp");
    });
  });

  /**
   * CRM-P2-09. Whether an organisation wants a machine touching its customer
   * records at all is a different question from whether a caller may run a tool,
   * and every gate that existed answered only the second.
   */
  describe("CrmMcpService respects the tenant's own switch", () => {
    it("offers no tools at all when agent access is off", async () => {
      /**
       * An empty list rather than a refusal, because that is what the question
       * means: an MCP client is asking what it may call, and the honest answer is
       * nothing. It is also what stops a disabled tenant's catalogue from
       * advertising a surface that would refuse every call.
       */
      mcpSettings.isEnabled.mockResolvedValue(false);
      await expect(service.getAvailableTools(context)).resolves.toEqual([]);
      /** And it did not resolve a scope per tool to decide that. */
      expect(accessService.scopeFor).not.toHaveBeenCalled();
    });

    it("refuses a call, in words that are not the scoped-token refusal", async () => {
      /**
       * The two must stay distinguishable. "Your token cannot do that" sends an
       * integrator to their scopes; "this organisation has agent access off"
       * sends them to an operator, and confusing the two wastes a support cycle
       * on each.
       */
      mcpSettings.isEnabled.mockResolvedValue(false);

      await expect(
        service.executeTool(context, { name: "crm_list_parties", arguments: {} }),
      ).rejects.toThrow(/switched off for this organisation/i);
    });

    it("records the refused call rather than dropping it", async () => {
      /**
       * A call arriving at a switched-off tenant is worth a record: it is either
       * an integration nobody told the operator about, or a credential that
       * outlived the decision to stop using it.
       */
      mcpSettings.isEnabled.mockResolvedValue(false);

      await service
        .executeTool(context, { name: "crm_list_parties", arguments: {} })
        .catch(() => undefined);

      expect(audit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({ action: "crm.mcp.tool_refused" }),
      );
    });

    it("checks the switch before it resolves the tool, so an unknown name is refused the same way", async () => {
      /**
       * Ordering. If the tool lookup came first, a disabled tenant would get
       * "unknown tool" for a name that does not exist and "switched off" for one
       * that does — which tells an unauthorised caller which tools are real.
       */
      mcpSettings.isEnabled.mockResolvedValue(false);

      await expect(
        service.executeTool(context, { name: "crm_not_a_tool", arguments: {} }),
      ).rejects.toThrow(/switched off for this organisation/i);
    });
  });
});
