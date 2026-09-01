import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrSafetyService } from "../hr-safety.service";
import { HrAuditService } from "../../core/hr-audit.service";

const mockSelectFn = jest.fn().mockReturnThis();
const mockFromFn = jest.fn().mockReturnThis();
const mockWhereFn = jest.fn().mockReturnThis();
const mockOrderByFn = jest.fn().mockReturnThis();
const mockLimitFn = jest.fn().mockResolvedValue([]);
const mockExecuteFn = jest.fn().mockResolvedValue([]);
const mockInsertFn = jest.fn().mockReturnThis();
const mockValuesFn = jest.fn().mockReturnThis();
const mockReturningFn = jest.fn().mockResolvedValue([]);

const mockDb = {
  select: mockSelectFn,
  from: mockFromFn,
  where: mockWhereFn,
  orderBy: mockOrderByFn,
  limit: mockLimitFn,
  execute: mockExecuteFn,
  insert: mockInsertFn,
  values: mockValuesFn,
  returning: mockReturningFn,
};

const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };

function makeIncident(id: number, occurredAt: Date) {
  return {
    id,
    orgId: "org1",
    incidentNumber: `INC-2024-${id}`,
    type: "injury" as const,
    location: "Warehouse A",
    occurredAt,
    reportedBy: "reporter1",
    severity: "medium" as const,
    status: "open" as const,
    medicalAttention: false,
    createdAt: occurredAt,
    description: "Test incident description",
    deletedAt: null,
  };
}

describe("HrSafetyService — cursor pagination (listIncidents)", () => {
  let service: HrSafetyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockOrderByFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockExecuteFn.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrSafetyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrSafetyService);
  });

  it("returns hasMore=false and no nextCursor when rows <= limit", async () => {
    const rows = [makeIncident(3, new Date("2024-01-03")), makeIncident(2, new Date("2024-01-02"))];
    mockLimitFn.mockResolvedValueOnce(rows);

    const result = await service.listIncidents("org1", { limit: 20 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("returns hasMore=true and nextCursor when rows > limit", async () => {
    const ts = new Date("2024-01-10T00:00:00.000Z");
    const rows = Array.from({ length: 21 }, (_, i) => makeIncident(21 - i, ts));
    mockLimitFn.mockResolvedValueOnce(rows);

    const result = await service.listIncidents("org1", { limit: 20 });

    expect(result.data).toHaveLength(20);
    expect(result.pagination.hasMore).toBe(true);
    expect(typeof result.pagination.nextCursor).toBe("string");
  });

  it("tie-break: cursor encodes both occurredAt and id when two rows share the same timestamp", async () => {
    const sharedTs = new Date("2024-06-15T12:00:00.000Z");
    const rowA = makeIncident(20, sharedTs);
    const rowB = makeIncident(19, sharedTs);
    mockLimitFn.mockResolvedValueOnce([rowA, rowB]);

    const page1 = await service.listIncidents("org1", { limit: 1 });

    expect(page1.data).toHaveLength(1);
    expect(page1.data[0]!.id).toBe(20);
    expect(page1.pagination.hasMore).toBe(true);

    const cursor = page1.pagination.nextCursor!;
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    expect(decoded).toContain(sharedTs.toISOString());
    expect(decoded).toContain("20");
  });

  it("tie-break: rows with same occurredAt but different ids are not skipped or duplicated across pages", async () => {
    const sharedTs = new Date("2024-06-15T12:00:00.000Z");
    const rowA = makeIncident(20, sharedTs);
    const rowB = makeIncident(19, sharedTs);

    mockLimitFn.mockResolvedValueOnce([rowA, rowB]);
    const page1 = await service.listIncidents("org1", { limit: 1 });
    expect(page1.data[0]!.id).toBe(20);

    mockLimitFn.mockResolvedValueOnce([rowB]);
    const page2 = await service.listIncidents("org1", { limit: 1, cursor: page1.pagination.nextCursor ?? undefined });
    expect(page2.data[0]!.id).toBe(19);
    expect(page2.pagination.hasMore).toBe(false);

    const page1Ids = page1.data.map((r) => r.id);
    const page2Ids = page2.data.map((r) => r.id);
    const intersection = page1Ids.filter((id) => page2Ids.includes(id));
    expect(intersection).toHaveLength(0);
  });
});
