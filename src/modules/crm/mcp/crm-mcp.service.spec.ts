import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmMcpService, type McpContext } from "./crm-mcp.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";

describe("CrmMcpService", () => {
  let service: CrmMcpService;
  let audit: { logCritical: jest.Mock };
  let accessService: { resolveUserPermissions: jest.Mock };
  let partyService: { list: jest.Mock; findOne: jest.Mock };
  let dealsService: { list: jest.Mock; findOne: jest.Mock };
  let activitiesService: { list: jest.Mock };
  let reportingService: { preview: jest.Mock };

  const context: McpContext = {
    userId: "usr_agent_123",
    orgId: "org_crm_test",
  };

  beforeEach(async () => {
    accessService = {
      resolveUserPermissions: jest.fn(),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmMcpService,
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: accessService },
        { provide: PartyService, useValue: partyService },
        { provide: DealsService, useValue: dealsService },
        { provide: ActivitiesService, useValue: activitiesService },
        { provide: ReportingService, useValue: reportingService },
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
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["crm:deals:read", "all"]]),
      );

      const available = await service.getAvailableTools(context);
      const names = available.map((t) => t.name);

      expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
      expect(names).not.toContain("crm_list_parties");
      expect(names).not.toContain("crm_run_report");
    });
  });

  describe("tool execution and authorization", () => {
    it("allows deal listing when caller has crm:deals:read", async () => {
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["crm:deals:read", "all"]]),
      );
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
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["party:parties:view", "all"]]),
      );

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
     * This check used to ask `resolved.has(key)`, which is true for a key
     * resolved to `"none"` — so a permission the resolver had explicitly denied
     * read as granted here, and only here: every `@RequirePermission` route goes
     * through `AccessService.holds`, which is `scopeFor(...) !== "none"`.
     */
    it("refuses a permission the resolver denied by scope rather than by absence", async () => {
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["crm:deals:read", "none"]]),
      );

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: {} }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.list).not.toHaveBeenCalled();
    });

    it("refuses party listing with 403 Forbidden when caller lacks party:parties:view", async () => {
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["crm:deals:read", "all"]]),
      );

      await expect(
        service.executeTool(context, {
          name: "crm_list_parties",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(partyService.list).not.toHaveBeenCalled();
    });

    it("throws NotFoundException on unknown tools", async () => {
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["*", "all"]]),
      );

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
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["party:parties:view", "all"]]),
      );
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
      accessService.resolveUserPermissions.mockResolvedValue(new Map<string, DataScope>());

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

    it("executes crm_get_party with caller's orgId", async () => {
      accessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["party:parties:view", "all"]]),
      );
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
});
