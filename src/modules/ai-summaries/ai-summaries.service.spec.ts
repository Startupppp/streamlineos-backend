import { Test, type TestingModule } from "@nestjs/testing";
import { AiSummariesService } from "./ai-summaries.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { AiSummarySnapshot } from "../../db/schema/ai/ai-summaries";
import type { SnapshotStructured } from "./ai-summaries.types";

const ORG_ID = "org-1";
const ENTITY_TYPE = "project";
const ENTITY_ID = "proj-42";
const USER_ID = "user-99";

const baseSnapshot = (overrides: Partial<AiSummarySnapshot> = {}): AiSummarySnapshot => ({
  id: 1,
  orgId: ORG_ID,
  entityType: ENTITY_TYPE,
  entityId: ENTITY_ID,
  summary: "Summary text",
  structured: { highlights: ["H1"], blockers: ["B1"], nextActions: ["N1"] },
  citations: null,
  correlationId: null,
  generatedBy: USER_ID,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const makeInsertDb = (returnRow: AiSummarySnapshot) => ({
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([returnRow]),
    }),
  }),
  select: jest.fn(),
});

const makeSelectDb = (rows: AiSummarySnapshot[]) => ({
  insert: jest.fn(),
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }),
});

describe("AiSummariesService", () => {
  describe("saveSnapshot", () => {
    it("inserts a row and returns it", async () => {
      const row = baseSnapshot();
      const db = makeInsertDb(row);
      const module: TestingModule = await Test.createTestingModule({
        providers: [AiSummariesService, { provide: DRIZZLE, useValue: db }],
      }).compile();
      const svc = module.get(AiSummariesService);

      const result = await svc.saveSnapshot(
        ORG_ID,
        ENTITY_TYPE,
        ENTITY_ID,
        { summary: "Summary text", structured: { highlights: ["H1"], blockers: ["B1"], nextActions: ["N1"] } },
        USER_ID,
      );

      expect(db.insert).toHaveBeenCalled();
      expect(result).toEqual(row);
    });
  });

  describe("getLatestWithDiff", () => {
    it("returns null when no rows exist", async () => {
      const db = makeSelectDb([]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [AiSummariesService, { provide: DRIZZLE, useValue: db }],
      }).compile();
      const svc = module.get(AiSummariesService);

      const result = await svc.getLatestWithDiff(ORG_ID, ENTITY_TYPE, ENTITY_ID);
      expect(result).toBeNull();
    });

    it("returns { snapshot, diff: null } when only one row exists", async () => {
      const row = baseSnapshot();
      const db = makeSelectDb([row]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [AiSummariesService, { provide: DRIZZLE, useValue: db }],
      }).compile();
      const svc = module.get(AiSummariesService);

      const result = await svc.getLatestWithDiff(ORG_ID, ENTITY_TYPE, ENTITY_ID);
      expect(result).not.toBeNull();
      expect(result!.snapshot).toEqual(row);
      expect(result!.diff).toBeNull();
    });

    it("computes added/removed correctly across two snapshots", async () => {
      const priorStructured: SnapshotStructured = { highlights: ["A", "B"], blockers: [], nextActions: [] };
      const currentStructured: SnapshotStructured = { highlights: ["B", "C"], blockers: [], nextActions: [] };
      const current = baseSnapshot({ id: 2, structured: currentStructured, createdAt: new Date("2026-01-02T00:00:00Z") });
      const prior = baseSnapshot({ id: 1, structured: priorStructured, createdAt: new Date("2026-01-01T00:00:00Z") });
      const db = makeSelectDb([current, prior]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [AiSummariesService, { provide: DRIZZLE, useValue: db }],
      }).compile();
      const svc = module.get(AiSummariesService);

      const result = await svc.getLatestWithDiff(ORG_ID, ENTITY_TYPE, ENTITY_ID);
      expect(result).not.toBeNull();
      expect(result!.diff).not.toBeNull();
      expect(result!.diff!.highlights.added).toEqual(["C"]);
      expect(result!.diff!.highlights.removed).toEqual(["A"]);
      expect(result!.diff!.highlights.changed).toEqual([]);
    });

    it("sets isSameSnapshot true when structured is identical", async () => {
      const structured: SnapshotStructured = { highlights: ["X"], blockers: ["Y"], nextActions: ["Z"] };
      const current = baseSnapshot({ id: 2, structured, createdAt: new Date("2026-01-02T00:00:00Z") });
      const prior = baseSnapshot({ id: 1, structured, createdAt: new Date("2026-01-01T00:00:00Z") });
      const db = makeSelectDb([current, prior]);
      const module: TestingModule = await Test.createTestingModule({
        providers: [AiSummariesService, { provide: DRIZZLE, useValue: db }],
      }).compile();
      const svc = module.get(AiSummariesService);

      const result = await svc.getLatestWithDiff(ORG_ID, ENTITY_TYPE, ENTITY_ID);
      expect(result!.diff!.isSameSnapshot).toBe(true);
    });
  });
});
