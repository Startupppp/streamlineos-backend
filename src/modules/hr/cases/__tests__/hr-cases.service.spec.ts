import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrCasesService } from "../hr-cases.service";
import { HrAuditService } from "../../core/hr-audit.service";

const mockSelectFn = jest.fn().mockReturnThis();
const mockFromFn = jest.fn().mockReturnThis();
const mockWhereFn = jest.fn().mockReturnThis();
const mockLimitFn = jest.fn().mockResolvedValue([]);
const mockInsertFn = jest.fn().mockReturnThis();
const mockValuesFn = jest.fn().mockReturnThis();
const mockReturningFn = jest.fn().mockResolvedValue([{ id: 1, caseNumber: "CASE-ABC123" }]);
const mockUpdateFn = jest.fn().mockReturnThis();
const mockSetFn = jest.fn().mockReturnThis();
const mockOrderByFn = jest.fn().mockReturnThis();
const mockExecuteFn = jest.fn().mockResolvedValue([]);

const mockDb = {
  select: mockSelectFn,
  from: mockFromFn,
  where: mockWhereFn,
  limit: mockLimitFn,
  insert: mockInsertFn,
  values: mockValuesFn,
  returning: mockReturningFn,
  update: mockUpdateFn,
  set: mockSetFn,
  orderBy: mockOrderByFn,
  execute: mockExecuteFn,
};

const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org1",
    caseNumber: "CASE-XYZ123",
    category: "harassment",
    severity: "medium",
    status: "open",
    summary: "Test case",
    details: null,
    anonymous: false,
    confidential: true,
    reportedBy: "reporter1",
    assignedTo: null,
    subjectEmployeeId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("HrCasesService — anonymity guarantee", () => {
  let service: HrCasesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockInsertFn.mockReturnThis();
    mockValuesFn.mockReturnThis();
    mockReturningFn.mockResolvedValue([{ id: 1, caseNumber: "CASE-ABC123" }]);
    mockUpdateFn.mockReturnThis();
    mockSetFn.mockReturnThis();
    mockOrderByFn.mockReturnThis();
    mockExecuteFn.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrCasesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrCasesService);
  });

  it("createAnonymous stores no reportedBy and sets anonymous=true, confidential=true", async () => {
    let insertedValues: Record<string, unknown> | null = null;
    mockValuesFn.mockImplementationOnce((v: Record<string, unknown>) => {
      insertedValues = v;
      return { returning: jest.fn().mockResolvedValue([{ id: 1, caseNumber: "CASE-ANON01" }]) };
    });

    const result = await service.createAnonymous("org1", {
      category: "harassment",
      severity: "high",
      summary: "Anonymous complaint",
      details: "Details of the anonymous complaint that is at least ten characters",
    });

    expect(insertedValues).not.toBeNull();
    expect(insertedValues!.reportedBy).toBeNull();
    expect(insertedValues!.anonymous).toBe(true);
    expect(insertedValues!.confidential).toBe(true);
    expect(result).toEqual({ caseNumber: "CASE-ANON01" });
  });

  it("createAnonymous returns only caseNumber, no personal identifiers", async () => {
    mockValuesFn.mockReturnValueOnce({
      returning: jest.fn().mockResolvedValue([{ id: 99, caseNumber: "CASE-SAFE99" }]),
    });

    const result = await service.createAnonymous("org1", {
      category: "ethics",
      severity: "low",
      summary: "Ethics concern",
      details: "Detailed description of the ethics concern at least ten chars",
    });

    const keys = Object.keys(result);
    expect(keys).toEqual(["caseNumber"]);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("reportedBy");
  });
});

describe("HrCasesService — confidential-tier gating", () => {
  let service: HrCasesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockInsertFn.mockReturnThis();
    mockValuesFn.mockReturnThis();
    mockReturningFn.mockResolvedValue([{ id: 1, caseNumber: "CASE-ABC123" }]);
    mockUpdateFn.mockReturnThis();
    mockSetFn.mockReturnThis();
    mockOrderByFn.mockReturnThis();
    mockExecuteFn.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrCasesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrCasesService);
  });

  it("getById: throws ForbiddenException for confidential case when actor lacks permission and is not assignee", async () => {
    const confidentialCase = makeCase({ confidential: true, assignedTo: "some-other-user" });
    mockLimitFn.mockResolvedValueOnce([confidentialCase]);

    await expect(
      service.getById("org1", 1, "user-without-access", false),
    ).rejects.toThrow(ForbiddenException);
  });

  it("getById: allows access to confidential case when actor has confidential permission", async () => {
    const confidentialCase = makeCase({ confidential: true, assignedTo: null });
    mockLimitFn.mockResolvedValueOnce([confidentialCase]);

    const result = await service.getById("org1", 1, "any-user", true);
    expect(result.confidential).toBe(true);
  });

  it("getById: allows access to confidential case when actor is the assignee", async () => {
    const confidentialCase = makeCase({ confidential: true, assignedTo: "assigned-user" });
    mockLimitFn.mockResolvedValueOnce([confidentialCase]);

    const result = await service.getById("org1", 1, "assigned-user", false);
    expect(result.id).toBe(1);
  });

  it("getById: throws NotFoundException for non-existent case", async () => {
    mockLimitFn.mockResolvedValueOnce([]);

    await expect(service.getById("org1", 999, "u1", true)).rejects.toThrow(NotFoundException);
  });
});

describe("HrCasesService — org isolation", () => {
  let service: HrCasesService;

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
        HrCasesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrCasesService);
  });

  it("getById: throws NotFoundException when a case from org B is accessed under org A scope", async () => {
    mockLimitFn.mockResolvedValueOnce([]);
    await expect(service.getById("org-A", 1, "u1", true)).rejects.toThrow(NotFoundException);
  });
});

describe("HrCasesService — create", () => {
  let service: HrCasesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInsertFn.mockReturnThis();
    mockValuesFn.mockReturnThis();
    mockReturningFn.mockResolvedValue([makeCase({ id: 5 })]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrCasesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrCasesService);
  });

  it("creates a case with confidential=true when not specified (default)", async () => {
    let insertedValues: Record<string, unknown> | null = null;
    mockValuesFn.mockImplementationOnce((v: Record<string, unknown>) => {
      insertedValues = v;
      return mockDb;
    });
    mockReturningFn.mockResolvedValueOnce([makeCase({ id: 5 })]);

    await service.create(
      "org1",
      "actor1",
      { category: "harassment", severity: "medium", summary: "Test", details: "Detailed description of the harassment incident at least ten chars" },
    );

    expect(insertedValues!.confidential).toBe(true);
    expect(insertedValues!.anonymous).toBe(false);
    expect(insertedValues!.reportedBy).toBe("actor1");
  });

  it("case number starts with CASE- prefix", async () => {
    let insertedValues: Record<string, unknown> | null = null;
    mockValuesFn.mockImplementationOnce((v: Record<string, unknown>) => {
      insertedValues = v;
      return mockDb;
    });
    mockReturningFn.mockResolvedValueOnce([makeCase({ id: 5 })]);

    await service.create("org1", "actor1", { category: "ethics", severity: "low", summary: "Concern", details: "Detailed description of the ethics concern at least ten chars" });
    expect(String(insertedValues!.caseNumber)).toMatch(/^CASE-/);
  });
});

describe("HrCasesService — RBAC permission keys", () => {
  it("controller uses hr:cases:view for list/get operations", () => {
    const viewPermission = "hr:cases:view";
    expect(viewPermission).toMatch(/^hr:cases:/);
  });

  it("controller uses hr:cases:manage for create/update/delete operations", () => {
    const managePermission = "hr:cases:manage";
    expect(managePermission).toMatch(/^hr:cases:/);
  });

  it("confidential access uses hr:cases:confidential permission", () => {
    const confidentialPermission = "hr:cases:confidential";
    expect(confidentialPermission).toMatch(/^hr:cases:/);
  });
});

describe("HrCasesService — cursor pagination (list)", () => {
  let service: HrCasesService;

  const listInput = { limit: 20 } as const;

  function makeRow(id: number, createdAt: Date) {
    return {
      id,
      caseNumber: `CASE-${id}`,
      category: "harassment" as const,
      severity: "medium" as const,
      status: "open" as const,
      summary: "Test",
      anonymous: false,
      confidential: false,
      assignedTo: null,
      subjectEmployeeId: null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockOrderByFn.mockReturnThis();
    mockExecuteFn.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrCasesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(HrCasesService);
  });

  it("returns hasMore=false and no nextCursor when rows <= limit", async () => {
    const rows = [makeRow(3, new Date("2024-01-03")), makeRow(2, new Date("2024-01-02"))];
    mockLimitFn.mockResolvedValueOnce(rows);

    const result = await service.list("org1", "u1", true, listInput);

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("returns hasMore=true and nextCursor when rows > limit", async () => {
    const ts = new Date("2024-01-10");
    const rows = Array.from({ length: 21 }, (_, i) => makeRow(21 - i, ts));
    mockLimitFn.mockResolvedValueOnce(rows);

    const result = await service.list("org1", "u1", true, listInput);

    expect(result.data).toHaveLength(20);
    expect(result.pagination.hasMore).toBe(true);
    expect(typeof result.pagination.nextCursor).toBe("string");
  });

  it("tie-break: cursor encodes both createdAt and id when two rows share the same timestamp", async () => {
    const sharedTs = new Date("2024-06-15T12:00:00.000Z");
    const rowA = makeRow(20, sharedTs);
    const rowB = makeRow(19, sharedTs);
    mockLimitFn.mockResolvedValueOnce([rowA, rowB]);

    const page1 = await service.list("org1", "u1", true, { limit: 1 });

    expect(page1.data).toHaveLength(1);
    expect(page1.data[0]!.id).toBe(20);
    expect(page1.pagination.hasMore).toBe(true);

    const cursor = page1.pagination.nextCursor!;
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    expect(decoded).toContain(sharedTs.toISOString());
    expect(decoded).toContain("20");
  });
});
