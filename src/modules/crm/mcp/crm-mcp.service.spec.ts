import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmMcpService, type McpContext } from "./crm-mcp.service";
import { AccessService } from "../../access/access.service";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";

describe("CrmMcpService", () => {
  let service: CrmMcpService;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmMcpService,
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
      // User only has deals view permission
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["crm:deals:view"],
      });

      const available = await service.getAvailableTools(context);
      const names = available.map((t) => t.name);

      expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
      expect(names).not.toContain("crm_list_parties");
      expect(names).not.toContain("crm_run_report");
    });
  });

  describe("tool execution and authorization", () => {
    it("allows deal listing when caller has crm:deals:view", async () => {
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["crm:deals:view"],
      });
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

    it("refuses deal listing with 403 Forbidden when caller lacks crm:deals:view", async () => {
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["party:parties:view"], // lacks crm:deals:view
      });

      await expect(
        service.executeTool(context, {
          name: "crm_list_deals",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.list).not.toHaveBeenCalled();
    });

    it("refuses party listing with 403 Forbidden when caller lacks party:parties:view", async () => {
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["crm:deals:view"], // lacks party:parties:view
      });

      await expect(
        service.executeTool(context, {
          name: "crm_list_parties",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(partyService.list).not.toHaveBeenCalled();
    });

    it("throws NotFoundException on unknown tools", async () => {
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["*"],
      });

      await expect(
        service.executeTool(context, {
          name: "payroll_post_run",
          arguments: {},
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("executes crm_get_party with caller's orgId", async () => {
      accessService.resolveUserPermissions.mockResolvedValue({
        permissions: ["party:parties:view"],
      });
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
