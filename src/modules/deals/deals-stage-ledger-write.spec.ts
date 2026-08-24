jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import type { Db } from "../../db/drizzle.module";
import { DealsService } from "./deals.service";
import { CrmBlueprintsService } from "../crm/metadata/crm-blueprints.service";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";

/**
 * The ledger has to be written by the same transaction that moves the deal.
 *
 * These assert both halves of that: the row's shape (a system move never wears a
 * person's id) and its placement (inside the transaction, not beside it). The
 * placement is the one that matters — a ledger written outside can survive an
 * update that rolled back, and then the record of what the system did is a
 * record of something that never happened.
 */

interface Captured {
  outsideTransaction: unknown[][];
  insideTransaction: unknown[][];
}

function makeMockDb(captured: Captured): Db {
  const updateReturning = jest
    .fn()
    .mockResolvedValue([{ id: 1, stage: "PROPOSAL", orgId: "org1", name: "Acme", pipelineId: "pipe1" }]);

  const capturingInsert = (sink: unknown[][]) =>
    jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((rows: unknown) => {
        sink.push(Array.isArray(rows) ? rows : [rows]);
        return { returning: jest.fn().mockResolvedValue([]) };
      }),
    }));

  const emptySelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  });

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
    insert: capturingInsert(captured.outsideTransaction),
    select: emptySelect,
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: updateReturning }),
          }),
        }),
        insert: capturingInsert(captured.insideTransaction),
        select: emptySelect,
      }),
    ),
  } as unknown as Db;
}

function transitionRows(sink: unknown[][]): Record<string, unknown>[] {
  return sink
    .flat()
    .filter((row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && "actorKind" in row,
    );
}

describe("DealsService — the stage ledger", () => {
  let service: DealsService;
  let mockDb: Db;
  let captured: Captured;

  beforeEach(() => {
    captured = { outsideTransaction: [], insideTransaction: [] };
    mockDb = makeMockDb(captured);

    service = new DealsService(
      mockDb,
      {
        cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
        invalidate: jest.fn(),
        invalidatePattern: jest.fn().mockResolvedValue(undefined),
        invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      } as unknown as CacheService,
      { log: jest.fn() } as unknown as AuditService,
      { sendDealAssigned: jest.fn() } as unknown as EmailService,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as AutomationService,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhooksDispatchService,
      {
        assertTransitionAllowed: jest
          .fn()
          .mockResolvedValue({ allowed: true, requiresApproval: false, missingFields: [] }),
      } as unknown as CrmBlueprintsService,
      {
        getAggregate: jest.fn().mockResolvedValue({
          pipelines: [{ id: "pipe1", type: "deal", isDefault: true }],
          stages: [
            { key: "LEAD", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 10, isActive: true },
            { key: "PROPOSAL", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 50, isActive: true },
          ],
        }),
      } as unknown as CrmMetadataService,
      { evaluate: jest.fn().mockResolvedValue({ valid: true, errors: [] }) } as unknown as import("../crm/metadata/crm-validation.service").CrmValidationService,
      { emit: jest.fn().mockResolvedValue(undefined) } as unknown as import("../crm/automation-studio/crm-automation-bus.service").CrmAutomationBusService,
      {} as unknown as import("./deals-crud.service").DealsCrudService,
      {} as unknown as import("./deals-activities.service").DealsActivitiesService,
      {} as unknown as import("./deals-import-export.service").DealsImportExportService,
    );

    (mockDb.query.deals.findFirst as jest.Mock).mockResolvedValue({
      id: 1,
      stage: "LEAD",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      pipelineId: "pipe1",
      value: "100.00",
      lostReason: null,
      expectedCloseDate: null,
      notes: null,
      assignedToId: "user-1",
    });
  });

  it("writes the transition inside the transaction that moves the deal", async () => {
    await service.updateDeal("org1", "user-1", 1, { stage: "PROPOSAL" });

    expect(transitionRows(captured.insideTransaction)).toHaveLength(1);
    expect(transitionRows(captured.outsideTransaction)).toHaveLength(0);
  });

  it("records a person as the actor by default", async () => {
    await service.updateDeal("org1", "user-1", 1, { stage: "PROPOSAL" });

    expect(transitionRows(captured.insideTransaction)[0]).toMatchObject({
      fromStage: "LEAD",
      toStage: "PROPOSAL",
      actorKind: "human",
      actorUserId: "user-1",
      actorLabel: null,
    });
  });

  it("records the system as the actor without borrowing anyone's identity", async () => {
    await service.updateDeal(
      "org1",
      "user-1",
      1,
      { stage: "PROPOSAL" },
      { kind: "system", label: "stage-inference v3" },
    );

    expect(transitionRows(captured.insideTransaction)[0]).toMatchObject({
      actorKind: "system",
      actorUserId: null,
      actorLabel: "stage-inference v3",
    });
  });

  it("keeps the reason the move was made", async () => {
    await service.updateDeal(
      "org1",
      "user-1",
      1,
      { stage: "PROPOSAL", stageChangeReason: "Customer confirmed budget" },
      { kind: "system", label: "extraction" },
    );

    expect(transitionRows(captured.insideTransaction)[0]).toMatchObject({
      reason: "Customer confirmed budget",
    });
  });

  it("writes nothing when the stage did not actually change", async () => {
    await service.updateDeal("org1", "user-1", 1, { stage: "LEAD" });

    expect(transitionRows(captured.insideTransaction)).toHaveLength(0);
  });

  it("writes nothing when the update never touched the stage", async () => {
    await service.updateDeal("org1", "user-1", 1, { name: "Renamed" });

    expect(transitionRows(captured.insideTransaction)).toHaveLength(0);
  });

  it("stores the deal's worth in minor units, never the decimal", async () => {
    const setSpy = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, stage: "LEAD", orgId: "org1" }]),
      }),
    });
    (mockDb.transaction as jest.Mock).mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          update: jest.fn().mockReturnValue({ set: setSpy }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
          }),
        }),
    );

    await service.updateDeal("org1", "user-1", 1, { value: 1234.56 });

    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.valueMinor).toBe(123456);
    expect(written).not.toHaveProperty("value");
  });
});
