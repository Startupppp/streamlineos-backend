import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiSummariesService } from "./ai-summaries.service";

const OWNER_ORG = "org-owner-001";
const ATTACKER_ORG = "org-attacker-002";
const ENTITY_TYPE = "project";
const ENTITY_ID = "proj-123";

jest.mock("../../../common/tenant/run-in-tenant-transaction");

describe("AiSummariesService — tenant isolation", () => {
  let service: AiSummariesService;
  let runInTenantTransaction: jest.Mock;

  const mockDb = {} as never;

  beforeEach(() => {
    jest.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runInTenantTransaction = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ).runInTenantTransaction;

    service = new AiSummariesService(mockDb);
  });

  describe("getLatestWithDiff — cross-tenant isolation", () => {
    it("returns null when no snapshots exist for attacker org (cross-tenant DENY)", async () => {
      runInTenantTransaction.mockResolvedValueOnce([]);

      const result = await service.getLatestWithDiff(
        ATTACKER_ORG,
        ENTITY_TYPE,
        ENTITY_ID,
      );

      expect(result).toBeNull();
      expect(runInTenantTransaction).toHaveBeenCalledTimes(1);
      const [, , options] = runInTenantTransaction.mock.calls[0] as [
        unknown,
        unknown,
        { orgId: string },
      ];
      expect(options.orgId).toBe(ATTACKER_ORG);
    });

    it("returns snapshot for own org (CONTROL)", async () => {
      const snapshot = {
        id: 1,
        orgId: OWNER_ORG,
        entityType: ENTITY_TYPE,
        entityId: ENTITY_ID,
        summary: "Project is on track.",
        structured: {
          highlights: ["Sprint velocity up"],
          blockers: [],
          nextActions: ["Review PR"],
        },
        citations: null,
        correlationId: null,
        generatedBy: "user-1",
        createdAt: new Date(),
      };

      runInTenantTransaction.mockResolvedValueOnce([snapshot]);

      const result = await service.getLatestWithDiff(
        OWNER_ORG,
        ENTITY_TYPE,
        ENTITY_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.snapshot.orgId).toBe(OWNER_ORG);
      expect(result!.diff).toBeNull();
      const [, , options] = runInTenantTransaction.mock.calls[0] as [
        unknown,
        unknown,
        { orgId: string },
      ];
      expect(options.orgId).toBe(OWNER_ORG);
    });

    it("isolation: runInTenantTransaction receives orgId from caller, not a leaked value", async () => {
      runInTenantTransaction.mockResolvedValue([]);

      await service.getLatestWithDiff(OWNER_ORG, ENTITY_TYPE, ENTITY_ID);
      await service.getLatestWithDiff(ATTACKER_ORG, ENTITY_TYPE, ENTITY_ID);

      const calls = runInTenantTransaction.mock.calls as Array<
        [unknown, unknown, { orgId: string }]
      >;
      expect(calls[0]![2]!.orgId).toBe(OWNER_ORG);
      expect(calls[1]![2]!.orgId).toBe(ATTACKER_ORG);
    });
  });

  describe("saveSnapshot — write path carries orgId", () => {
    it("passes orgId to runInTenantTransaction on insert (CONTROL)", async () => {
      const saved = {
        id: 2,
        orgId: OWNER_ORG,
        entityType: ENTITY_TYPE,
        entityId: ENTITY_ID,
        summary: "Done.",
        structured: null,
        citations: null,
        correlationId: null,
        generatedBy: "user-1",
        createdAt: new Date(),
      };
      runInTenantTransaction.mockResolvedValueOnce([saved]);

      const result = await service.saveSnapshot(
        OWNER_ORG,
        ENTITY_TYPE,
        ENTITY_ID,
        {
          summary: "Done.",
          structured: null as never,
          citations: null,
          correlationId: null,
        },
        "user-1",
      );

      expect(result.orgId).toBe(OWNER_ORG);
      const [, , options] = runInTenantTransaction.mock.calls[0] as [
        unknown,
        unknown,
        { orgId: string },
      ];
      expect(options.orgId).toBe(OWNER_ORG);
    });
  });
});
