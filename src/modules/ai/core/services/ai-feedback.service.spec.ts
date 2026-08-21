jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { BadRequestException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AiFeedbackService } from "./ai-feedback.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";

const ORG_ID = "org-abc";
const USER_ID = "user-xyz";

const makeDb = (insertReturn: unknown = undefined, selectReturn: unknown[] = []) => ({
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockResolvedValue(insertReturn),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue(selectReturn),
});

describe("AiFeedbackService", () => {
  let service: AiFeedbackService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiFeedbackService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();
    service = module.get(AiFeedbackService);
  });

  describe("insertFeedback", () => {
    it("inserts with orgId and userId from caller, not from dto", async () => {
      await service.insertFeedback(ORG_ID, USER_ID, { feature: "kb-answer", rating: "UP" });
      expect(db.insert).toHaveBeenCalled();
      const inserted = db.values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.orgId).toBe(ORG_ID);
      expect(inserted.userId).toBe(USER_ID);
      expect(inserted.feature).toBe("kb-answer");
      expect(inserted.rating).toBe("UP");
    });

    it("throws BadRequestException when reason exceeds 1000 chars", async () => {
      await expect(
        service.insertFeedback(ORG_ID, USER_ID, {
          feature: "chat",
          rating: "DOWN",
          reason: "x".repeat(1001),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("accepts reason at exactly 1000 chars", async () => {
      await expect(
        service.insertFeedback(ORG_ID, USER_ID, {
          feature: "chat",
          rating: "UP",
          reason: "y".repeat(1000),
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("getSummary", () => {
    it("returns feature-grouped rows with ratio", async () => {
      db = makeDb(undefined, [
        { feature: "kb-answer", up: 8, down: 2, total: 10 },
        { feature: "chat", up: 3, down: 3, total: 6 },
      ]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AiFeedbackService,
          { provide: DRIZZLE, useValue: db },
        ],
      }).compile();
      const svc = module.get(AiFeedbackService);

      const result = await svc.getSummary(ORG_ID);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ feature: "kb-answer", up: 8, down: 2, total: 10, ratio: 0.8 });
      expect(result[1]).toMatchObject({ feature: "chat", up: 3, down: 3, total: 6, ratio: 0.5 });
    });

    it("returns ratio null when total is 0", async () => {
      db = makeDb(undefined, [{ feature: "crm-ai", up: 0, down: 0, total: 0 }]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AiFeedbackService,
          { provide: DRIZZLE, useValue: db },
        ],
      }).compile();
      const svc = module.get(AiFeedbackService);

      const result = await svc.getSummary(ORG_ID, "crm-ai");
      expect(result[0].ratio).toBeNull();
    });
  });
});
