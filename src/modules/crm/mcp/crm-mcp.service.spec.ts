import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
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
import { queryDescriptionSchema } from "../../reporting/dto/reporting.schemas";
import { REPORTING_REGISTRY, fieldsOf } from "../../reporting/compiler/registry";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";
import {
  MODULE_AVAILABLE,
  MODULE_DISABLED,
  makeAuthContextFactory,
} from "../../../../test/helpers/module-guard-context";
import { ScopedRead } from "../../access/scoped-read";

describe("CrmMcpService", () => {
  let service: CrmMcpService;
  let audit: { logCritical: jest.Mock; logCriticalOutsideTransaction: jest.Mock };
  let mcpSettings: { isEnabled: jest.Mock };
  let accessService: {
    scopeFor: jest.Mock;
    getModuleState: jest.Mock;
    buildModuleAvailabilityResolver: jest.Mock;
  };
  let partyService: { listParties: jest.Mock; getParty: jest.Mock };
  let dealsService: { listDeals: jest.Mock; getDeal: jest.Mock };
  let activitiesService: { timeline: jest.Mock };
  let reportingService: { runAdHoc: jest.Mock };

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
    /*
     * Named for the methods these services actually have.
     *
     * They were `list`, `findOne` and `preview` — none of which exists on any of
     * the four. The handler probed for exactly those names and fell back when it
     * did not find them, so doubles shaped from the handler's imagination
     * satisfied the dead branch and the suite stayed green over six broken
     * tools. A double built from the caller rather than from the callee can only
     * ever confirm the caller. `the doubles are the real methods` below pins
     * these names to the real prototypes so they cannot drift again.
     */
    partyService = {
      listParties: jest.fn(),
      getParty: jest.fn(),
    };
    dealsService = {
      listDeals: jest.fn(),
      getDeal: jest.fn(),
    };
    activitiesService = {
      timeline: jest.fn(),
    };
    reportingService = {
      runAdHoc: jest.fn(),
    };

    audit = {
      logCritical: jest.fn().mockResolvedValue(undefined),
      logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
    };
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
        /*
         * main's authorize() asks the AuthContext whether a module is on,
         * where it used to ask AccessService. The double answers from the same
         * getModuleState switch the tests flip, and core namespaces such as
         * `party` stay on, as the real resolver keeps them.
         */
        {
          provide: AuthContextFactory,
          useValue: makeAuthContextFactory({
            moduleAvailability: async (user, moduleKey) =>
              isCoreModuleKey(moduleKey) ||
              (await accessService.getModuleState(user.orgId, moduleKey))
                ? MODULE_AVAILABLE
                : MODULE_DISABLED,
          }),
        },
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
      dealsService.listDeals.mockResolvedValue({
        items: [{ id: 1, name: "Big Enterprise Deal" }],
        total: 1,
      });

      const result = await service.executeTool(context, {
        name: "crm_list_deals",
        arguments: { limit: 20, stage: "won" },
      });

      /*
       * The caller's identity and DataScope reach the query as one ScopedRead:
       * the org, the actor and the resolved scope are all asserted, because the
       * old call passed none of them and every agent read the whole org.
       */
      expect(dealsService.listDeals).toHaveBeenCalledTimes(1);
      const [read, query] = dealsService.listDeals.mock.calls[0] as [ScopedRead, unknown];
      expect(read).toBeInstanceOf(ScopedRead);
      expect(read.orgId).toBe("org_crm_test");
      expect(read.actorId).toBe("usr_agent_123");
      expect(read.unrestricted).toBe(true);
      expect(query).toEqual({ limit: 20, stage: "won" });
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

      expect(dealsService.listDeals).not.toHaveBeenCalled();
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

      expect(dealsService.listDeals).not.toHaveBeenCalled();
    });

    it("refuses party listing with 403 Forbidden when caller lacks party:parties:view", async () => {
      grantScopes([["crm:deals:read", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_list_parties",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(partyService.listParties).not.toHaveBeenCalled();
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
      partyService.listParties.mockResolvedValue({ data: [{ id: "p1" }, { id: "p2" }] });

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

    /**
     * The refusal entries name `logCriticalOutsideTransaction`, and which
     * method they name is the whole assertion.
     *
     * `logCritical` writes through the request's transaction, and a refusal is
     * delivered by throwing — so `TenantContextInterceptor` rolls that
     * transaction back and takes the row with it. This file cannot see that:
     * the audit service is a double here, so the call is recorded whichever
     * method receives it and every version of this test passed throughout the
     * defect. It pins the choice; `test/crm/crm-mcp-audit.seeded-e2e-spec.ts`
     * is what proves the row is still in `audit_logs` after the 403.
     */
    it("records a refusal where the refusal cannot roll it back", async () => {
      grantScopes([]);

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: { limit: 5 } }),
      ).rejects.toThrow(ForbiddenException);

      expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
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

      expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
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
      dealsService.listDeals.mockResolvedValue({ items: [] });

      await service.executeTool(agent, { name: "crm_list_deals", arguments: {} });

      expect(accessService.scopeFor).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: expect.objectContaining({
            kind: "agent-token",
            ceiling: ["crm:deals:read"],
          }),
        }),
        "crm:deals:read",
        // main's authorize() passes the request's AuthContext through.
        expect.anything(),
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

      expect(dealsService.listDeals).not.toHaveBeenCalled();
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
      partyService.getParty.mockResolvedValue({
        id: "pty_123",
        name: "Acme Corp",
      });

      const result = await service.executeTool(context, {
        name: "crm_get_party",
        arguments: { partyId: "pty_123" },
      });

      expect(partyService.getParty).toHaveBeenCalledWith("org_crm_test", "pty_123");
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

      expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
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
  /**
   * Every tool handed its service arguments that service does not accept.
   *
   * The file cast all four services to `Record<string, Function>` and probed for
   * a `list`, a `findOne`, a `preview`. None exists, so only the fallbacks ran —
   * and the cast meant nothing checked what the fallbacks were passed. Six tools
   * disagreed with six services and it all compiled. These cases are written
   * against the real signatures, so they fail if the cast comes back.
   */
  describe("the arguments each tool actually sends", () => {
    it("sends the search term under the name the party service reads", async () => {
      grantScopes([["party:parties:view", "all"]]);
      partyService.listParties.mockResolvedValue({ data: [] });

      await service.executeTool(context, {
        name: "crm_list_parties",
        arguments: { search: "acme corp", limit: 20 },
      });

      /*
       * `search`, not `query`. The handler built `{ query: args.search }` and
       * both the schema and the service read `search`, so the term was dropped
       * and every agent search returned page one of the whole book.
       */
      expect(partyService.listParties).toHaveBeenCalledWith(
        "org_crm_test",
        expect.objectContaining({ search: "acme corp" }),
      );
    });

    it("refuses a missing partyId rather than looking up the string \"undefined\"", async () => {
      grantScopes([["party:parties:view", "all"]]);

      await expect(
        service.executeTool(context, { name: "crm_get_party", arguments: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);

      /*
       * The assertion that carries the finding. The old guard was
       * `String(args.partyId)` followed by a truthiness test, and
       * `String(undefined)` is `"undefined"` — truthy — so a missing id reached
       * the database as that literal string. Proving the throw would not show
       * that; proving the query was never built does.
       */
      expect(partyService.getParty).not.toHaveBeenCalled();
    });

    it("refuses an unanchored timeline instead of returning an empty page", async () => {
      grantScopes([["crm:activities:view", "all"]]);

      await expect(
        service.executeTool(context, { name: "crm_list_activities", arguments: {} }),
      ).rejects.toBeTruthy();

      /*
       * Without an anchor the service falls to `subject_id = ''`, which matches
       * nothing — so the old handler answered "this deal has no activity" to a
       * question nobody had asked about a deal. Again the assertion is that no
       * query was built, because an empty result and a refused call look
       * identical from the return value.
       */
      expect(activitiesService.timeline).not.toHaveBeenCalled();
    });

    it("pages the timeline on a cursor, which is how the timeline pages", async () => {
      grantScopes([["crm:activities:view", "all"]]);
      activitiesService.timeline.mockResolvedValue({ data: [], nextCursor: null });

      await service.executeTool(context, {
        name: "crm_list_activities",
        arguments: { dealId: 42, cursor: "c_abc", limit: 10 },
      });

      const [, query] = activitiesService.timeline.mock.calls[0] as [string, Record<string, unknown>];
      expect(query).toMatchObject({ dealId: 42, cursor: "c_abc", limit: 10 });
      /* `page` meant nothing to a keyset timeline; it silently pinned every call to page one. */
      expect(query).not.toHaveProperty("page");
    });

    it("builds a report description the reporting compiler would accept", async () => {
      grantScopes([["crm:reports:view", "all"]]);
      reportingService.runAdHoc.mockResolvedValue({ columns: [], rows: [], rowCount: 0 });

      await service.executeTool(context, {
        name: "crm_run_report",
        arguments: { source: "deals" },
      });

      const [, description] = reportingService.runAdHoc.mock.calls[0] as [
        McpContext,
        Record<string, unknown>,
      ];

      /*
       * Three independent errors lived here, under one `as any`: `fields` where
       * the description takes `select`, field names belonging to no source, and
       * no `limit` at all — which the schema requires and the compiler refuses
       * without. Every call to this tool 400ed, always had, and no test noticed
       * because the double was named `preview`, a method that does not exist.
       *
       * Parsing under the real schema catches the shape; resolving each field
       * against the real registry catches the names. Asserting `select` is
       * merely non-empty would have passed on `["id", "name", "value"]`.
       */
      expect(() => queryDescriptionSchema.parse(description)).not.toThrow();

      const source = REPORTING_REGISTRY.get(String(description.source));
      expect(source).toBeDefined();
      const known = fieldsOf(source!);
      const projected = (description.select as { kind: string; field: string }[]).map((p) => p.field);
      expect(projected.length).toBeGreaterThan(0);
      for (const field of projected) expect(known.has(field)).toBe(true);
    });

    it("refuses a report source that is not in the registry", async () => {
      grantScopes([["crm:reports:view", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_run_report",
          arguments: { source: "payroll_runs" },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(reportingService.runAdHoc).not.toHaveBeenCalled();
    });
  });

  /**
   * The guard that stops the whole class coming back.
   *
   * The doubles in this file were named for methods none of these services has.
   * A double shaped from the caller can only ever confirm the caller, so the
   * suite was green across six broken tools. Pinning the names to the real
   * prototypes means a rename breaks this file rather than production.
   */
  describe("the doubles are the real methods", () => {
    const REAL: ReadonlyArray<[string, { prototype: object }, readonly string[]]> = [
      ["PartyService", PartyService, ["listParties", "getParty"]],
      ["DealsService", DealsService, ["listDeals", "getDeal"]],
      ["ActivitiesService", ActivitiesService, ["timeline"]],
      ["ReportingService", ReportingService, ["runAdHoc"]],
    ];

    it.each(REAL)("%s really has the methods this file doubles", (_label, ctor, methods) => {
      const own = Object.getOwnPropertyNames(ctor.prototype);
      for (const method of methods) expect(own).toContain(method);
    });

    it("and does not have the names the handler used to probe for", () => {
      /*
       * States the defect rather than the fix. `list`, `findOne` and `preview`
       * were the first branch of every probe; because none of them exists, every
       * first branch was unreachable and the fallback beneath it was the only
       * code that ever ran.
       */
      expect(Object.getOwnPropertyNames(PartyService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(PartyService.prototype)).not.toContain("findOne");
      expect(Object.getOwnPropertyNames(DealsService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(DealsService.prototype)).not.toContain("findOne");
      expect(Object.getOwnPropertyNames(ActivitiesService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(ReportingService.prototype)).not.toContain("preview");
    });
  });
  /**
   * What a tool advertises must be something it reads.
   *
   * `crm_list_parties` offered agents a `standing` filter and `crm_run_report` a
   * `reportKey`; nothing read either. `crm_list_deals` offered `pipelineId` and
   * `stageId` against an input type that has neither. A caller who filters a
   * list and receives the unfiltered list back cannot tell that it happened —
   * which makes an advertised-and-ignored parameter worse than a missing one.
   *
   * Read off the source rather than by calling, because a handler that ignores a
   * property cannot be made to reveal that by any argument you pass it.
   */
  describe("every advertised input is read by its handler", () => {
    /*
     * The handlers moved out of `crm-mcp.service.ts` into
     * `lib/crm-mcp-tool-handlers.ts` when the service was split, so that is the
     * file read. Their `case` labels sit at four spaces there, because the
     * switch is in a function rather than a method, and `handlerBody` below
     * cuts on that indentation.
     */
    const source = readFileSync(join(__dirname, "lib", "crm-mcp-tool-handlers.ts"), "utf8");

    /*
     * Comments are stripped first, and that is not fastidiousness. The handlers
     * carry a docblock naming `args.partyId`, `page` and `pipelineId` while
     * explaining what went wrong with them — so a search over raw text would
     * match this file's own explanation of the bug and report it fixed. I have
     * written that assertion before; it passes for the worst possible reason.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    function handlerBody(tool: string): string {
      const start = code.indexOf(`case "${tool}":`);
      expect(start).toBeGreaterThan(-1);
      const rest = code.slice(start + tool.length + 8);
      const next = rest.search(/\n {4}(?:case "|default:)/);
      return next === -1 ? rest : rest.slice(0, next);
    }

    /*
     * The catalogue is read off the service the module built, not off a
     * hand-constructed one. My first version did `new CrmMcpService({} as never
     * x8)` — jest ran it happily because ts-jest has diagnostics off here, and
     * `tsc` rejected it: the constructor takes seven. A spec that constructs a
     * class by hand breaks every time that class gains a dependency, and it
     * would have been asserting against a second definition of the catalogue.
     *
     * One `it` rather than `it.each`, because `it.each` needs its table when the
     * describe is defined and `service` does not exist until `beforeEach`.
     */
    it("reads every property it declares, for every tool", () => {
      expect(service.tools.length).toBeGreaterThanOrEqual(6);

      const unread: string[] = [];
      for (const tool of service.tools) {
        const body = handlerBody(tool.name);
        for (const prop of Object.keys(tool.inputSchema.properties))
          if (!body.includes(`args.${prop}`)) unread.push(`${tool.name}.${prop}`);
      }

      /* Named, so a failure says which parameter is a lie rather than just failing. */
      expect(unread).toEqual([]);
    });

  });
});
