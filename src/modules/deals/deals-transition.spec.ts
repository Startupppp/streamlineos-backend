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
import type { LifecycleService } from "../lifecycle/lifecycle.service";

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
  let mockWebhooksDispatch: { dispatch: jest.Mock };
  let mockDb: Db;
  let mockBlueprints: jest.Mocked<Pick<CrmBlueprintsService, "assertTransitionAllowed">>;
  let mockCrmMetadata: jest.Mocked<Pick<CrmMetadataService, "getAggregate">>;
  let mockLifecycle: jest.Mocked<Pick<LifecycleService, "recordClosedWon">>;

  beforeEach(() => {
    mockDb = makeMockDb();
    mockLifecycle = {
      recordClosedWon: jest
        .fn()
        .mockResolvedValue({ status: "opened", customerLifecycleId: "lc-1" }),
    };
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

    mockWebhooksDispatch = { dispatch: jest.fn().mockResolvedValue(undefined) };

    service = new DealsService(
      mockDb,
      { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()), invalidate: jest.fn(), invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
      { log: jest.fn() } as unknown as AuditService,
      { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as AutomationService,
      mockWebhooksDispatch as unknown as WebhooksDispatchService,
      mockBlueprints as unknown as CrmBlueprintsService,
      mockCrmMetadata as unknown as CrmMetadataService,
      { evaluate: jest.fn().mockResolvedValue({ valid: true, errors: [] }) } as unknown as import("../crm/metadata/crm-validation.service").CrmValidationService,
      { emit: jest.fn().mockResolvedValue(undefined) } as unknown as import("../crm/automation-studio/crm-automation-bus.service").CrmAutomationBusService,
      {} as unknown as import("./deals-crud.service").DealsCrudService,
      {} as unknown as import("./deals-activities.service").DealsActivitiesService,
      {} as unknown as import("./deals-import-export.service").DealsImportExportService,
      // The closed-won hook (P5-07). Stubbed rather than omitted so the win path
      // runs the same code it runs in production, minus the write.
      mockLifecycle as unknown as LifecycleService,
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

  /**
   * P5-07's reachability, asserted rather than assumed.
   *
   * A lifecycle service nothing calls is the failure this repository keeps
   * producing: written, registered, and reached by no code path. The stage
   * transition is the only trigger, so this is where the wire has to be proven.
   */
  it("opens a customer lifecycle when a deal reaches a won stage", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "PROPOSAL",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });

    await service.updateDeal("org1", "user1", 1, { stage: "WON" });

    expect(mockLifecycle.recordClosedWon).toHaveBeenCalledTimes(1);
    expect(mockLifecycle.recordClosedWon).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org1", dealId: 1 }),
    );
  });

  /**
   * And it is handed the TRANSACTION, not the service's own connection. A
   * lifecycle written outside the transaction that moved the deal survives that
   * move being rolled back, which puts recurring revenue in the book for a sale
   * that never closed.
   */
  it("hands the lifecycle the transaction rather than the outer connection", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "PROPOSAL",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });

    await service.updateDeal("org1", "user1", 1, { stage: "WON" });

    const [handed] = mockLifecycle.recordClosedWon.mock.calls[0]!;
    expect(handed).not.toBe(mockDb);
  });

  /** A move that is not a win opens nothing. */
  it("opens no lifecycle for a stage change that is not a win", async () => {
    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 1,
      orgId: "org1",
      stage: "LEAD",
      pipelineId: null,
      version: null,
      name: "Test Deal",
      assignedToId: null,
    });

    await service.updateDeal("org1", "user1", 1, { stage: "PROPOSAL" });

    expect(mockLifecycle.recordClosedWon).not.toHaveBeenCalled();
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
  /**
   * `deal.won` leaving the process, which nothing asserted.
   *
   * `deals.service.ts:415` has dispatched `deal.won` since outbound webhooks
   * shipped, and the seeded webhook e2e reaches `WebhooksDispatchService.dispatch`
   * off the Nest container rather than through a stage change -- deliberately, so
   * it can test the post-transaction condition, but it means the PRODUCER wiring
   * was covered by nothing. Delete line 415 and the whole suite stayed green.
   *
   * That is the exact half of CRM-P0-04/05 the handoff calls out as the original
   * bug: "deal.won has been wired the whole time and never left the process."
   * A dispatcher proven to sign and log correctly is worth nothing if the event
   * never reaches it.
   */
  describe("a deal reaching a terminal stage tells the outside world", () => {
    it("dispatches deal.won with the deal's identity and value", async () => {
      (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 1,
        orgId: "org1",
        stage: "PROPOSAL",
        pipelineId: null,
        version: null,
        name: "Test Deal",
        assignedToId: null,
      });

      await service.updateDeal("org1", "user1", 1, { stage: "WON" });

      expect(mockWebhooksDispatch.dispatch).toHaveBeenCalledWith(
        "org1",
        "deal.won",
        expect.objectContaining({ id: 1 }),
      );
    });

    it("dispatches deal.lost, not deal.won, when the deal is lost", async () => {
      (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 1,
        orgId: "org1",
        stage: "PROPOSAL",
        pipelineId: null,
        version: null,
        name: "Test Deal",
        assignedToId: null,
      });

      await service.updateDeal("org1", "user1", 1, { stage: "LOST" });

      const events = mockWebhooksDispatch.dispatch.mock.calls.map((call) => call[1]);
      /*
        Both halves. Asserting only that `deal.lost` fired would pass on an
        implementation that fired both, and a subscriber told a deal was won AND
        lost is worse off than one told nothing.
      */
      expect(events).toContain("deal.lost");
      expect(events).not.toContain("deal.won");
    });

    it("dispatches nothing for a move between open stages", async () => {
      (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 1,
        orgId: "org1",
        stage: "LEAD",
        pipelineId: null,
        version: null,
        name: "Test Deal",
        assignedToId: null,
      });

      await service.updateDeal("org1", "user1", 1, { stage: "PROPOSAL" });

      expect(mockWebhooksDispatch.dispatch).not.toHaveBeenCalled();
    });
  });
});
