jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { DealsService } from "./deals.service";
import { CrmBlueprintsService } from "../crm/metadata/crm-blueprints.service";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";

function makeMockDb(): Db {
  const updateReturning = jest.fn().mockResolvedValue([
    { id: 1, stage: "PROPOSAL", orgId: "org1", version: null, pipelineId: null },
  ]);
  return {
    query: {
      deals: { findFirst: jest.fn() },
      organizationMembers: { findMany: jest.fn().mockResolvedValue([]) },
      chatChannels: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: updateReturning }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    ),
  } as unknown as Db;
}

describe("DealsService – blueprint transition enforcement", () => {
  let service: DealsService;
  let mockDb: Db;
  let mockBlueprints: jest.Mocked<Pick<CrmBlueprintsService, "assertTransitionAllowed">>;
  let mockCrmMetadata: jest.Mocked<Pick<CrmMetadataService, "getAggregate">>;

  beforeEach(() => {
    mockDb = makeMockDb();
    mockBlueprints = { assertTransitionAllowed: jest.fn().mockResolvedValue({ allowed: true, requiresApproval: false, missingFields: [] }) };
    mockCrmMetadata = {
      getAggregate: jest.fn().mockResolvedValue({
        pipelines: [{ id: "pipe1", type: "deal", isDefault: true }],
        stages: [
          { key: "LEAD", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 10, isActive: true },
          { key: "PROPOSAL", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 50, isActive: true },
          { key: "WON", pipelineId: "pipe1", stageType: "won", isTerminal: true, probability: 100, isActive: true },
          { key: "LOST", pipelineId: "pipe1", stageType: "lost", isTerminal: true, probability: 0, isActive: true },
        ],
      }),
    };

    service = new DealsService(
      mockDb,
      { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()), invalidate: jest.fn(), invalidatePattern: jest.fn().mockResolvedValue(undefined), invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
      { log: jest.fn() } as unknown as AuditService,
      { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as AutomationService,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksDispatchService,
      mockBlueprints as unknown as CrmBlueprintsService,
      mockCrmMetadata as unknown as CrmMetadataService,
      { evaluate: jest.fn().mockResolvedValue({ valid: true, errors: [] }) } as unknown as import("../crm/metadata/crm-validation.service").CrmValidationService,
      { emit: jest.fn().mockResolvedValue(undefined) } as unknown as import("../crm/automation-studio/crm-automation-bus.service").CrmAutomationBusService,
      {} as unknown as import("./deals-crud.service").DealsCrudService,
      {} as unknown as import("./deals-activities.service").DealsActivitiesService,
      {} as unknown as import("./deals-import-export.service").DealsImportExportService,
    );
  });

  it("calls assertTransitionAllowed when stage changes", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "LEAD",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });
    (mockDb.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { id: 1, stage: "PROPOSAL", orgId: "org1", version: null, pipelineId: null },
          ]),
        }),
      }),
    });

    await service.updateDeal("org1", "user1", 1, { stage: "PROPOSAL" });

    expect(mockBlueprints.assertTransitionAllowed).toHaveBeenCalledWith(
      "org1",
      "pipe1",
      "LEAD",
      "PROPOSAL",
      expect.objectContaining({ stage: "PROPOSAL" }),
    );
  });

  it("does NOT call assertTransitionAllowed when stage is unchanged", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "PROPOSAL",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });
    (mockDb.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { id: 1, stage: "PROPOSAL", orgId: "org1", version: null, pipelineId: null },
          ]),
        }),
      }),
    });

    await service.updateDeal("org1", "user1", 1, { notes: "updated notes" });

    expect(mockBlueprints.assertTransitionAllowed).not.toHaveBeenCalled();
  });

  it("returns not_found when deal does not exist", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce(undefined);

    const result = await service.updateDeal("org1", "user1", 99, { stage: "WON" });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("propagates BadRequestException from blueprints when transition is blocked", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "LEAD",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });
    mockBlueprints.assertTransitionAllowed.mockRejectedValueOnce(
      new BadRequestException("Transition blocked: missing required field"),
    );

    await expect(service.updateDeal("org1", "user1", 1, { stage: "WON" })).rejects.toThrow(BadRequestException);
  });
});
