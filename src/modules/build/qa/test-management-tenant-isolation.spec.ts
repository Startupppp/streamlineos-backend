import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestManagementService } from "./test-management.service";
import { createTestCaseSchema } from "./dto/qa.schemas";

const MEMBERSHIP_ID = 7;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, isOrgOwner),
  };
}

function makeAccessGranted() {
  return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
}

function makeAccessEmpty() {
  return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
}

describe("TestManagementService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(projectRow: unknown | null, suiteRows: unknown[]) {
    let selectCall = 0;
    const suiteChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(suiteRows),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return selectCall === 1 ? suiteChain : countChain;
      }),
    } as unknown as Db;
  }

  it("throws NotFoundException for listSuites when project not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null, []);
    const svc = new TestManagementService(db, makeAccessEmpty());
    await expect(svc.listSuites(makeU(ATTACKER_ORG), 99, {})).rejects.toThrow(NotFoundException);
  });

  it("returns suites for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, managerMembershipId: null };
    const suite = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Suite A" };
    const db = makeDb(project, [suite]);
    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1, {});
    expect(result).toHaveLength(1);
  });
});

describe("TestManagementService — project membership gate (assertProjectAccess)", () => {
  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testSuites: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  function makeMemberDb() {
    let callCount = 0;
    const makeLimitChain = (rows: unknown[]) => {
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
      return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
    };
    const suitesChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testSuites: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return makeLimitChain([{ role: "MEMBER" }]);
        if (callCount === 2) return suitesChain;
        return countChain;
      }),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestManagementService(db, access);
    await expect(svc.listSuites(makeU("org-1"), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestManagementService(db, access);
    await expect(svc.listSuites(makeU("org-1"), 1, {})).resolves.toEqual([]);
  });
});

describe("TestManagementService — listSuites grouped case counts", () => {
  const OWNER_ORG = "org-owner";

  it("attaches caseCount per suite from a grouped query, not per-row", async () => {
    const suiteRow = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "S1", position: 0 };
    let selectCall = 0;
    const suiteChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([suiteRow]),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([{ suiteId: 1, caseCount: 3 }]),
        }),
      }),
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return selectCall === 1 ? suiteChain : countChain;
      }),
    } as unknown as Db;

    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1, {});

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, caseCount: 3 });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("returns caseCount 0 for a suite with no cases", async () => {
    const suiteRow = { id: 2, orgId: OWNER_ORG, projectId: 1, name: "S2", position: 0 };
    let selectCall = 0;
    const suiteChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([suiteRow]),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return selectCall === 1 ? suiteChain : countChain;
      }),
    } as unknown as Db;

    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1, {});

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 2, caseCount: 0 });
  });

  it("returns empty array without issuing counts query when no suites match", async () => {
    const suiteChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(suiteChain),
    } as unknown as Db;

    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1, {});

    expect(result).toHaveLength(0);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe("TestManagementService — listSuites cursor pagination", () => {
  const OWNER_ORG = "org-owner";

  it("returns only suites after the cursor id when cursor is provided", async () => {
    const suiteAfterCursor = { id: 6, orgId: OWNER_ORG, projectId: 1, name: "S6", position: 0 };
    let selectCall = 0;
    const suiteChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([suiteAfterCursor]),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return selectCall === 1 ? suiteChain : countChain;
      }),
    } as unknown as Db;

    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1, { cursor: 5 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 6 });
  });
});

describe("TestManagementService — createTestCaseSchema steps bound", () => {
  it("rejects steps array exceeding 200 entries", () => {
    const steps = Array.from({ length: 201 }, (_, i) => ({
      action: `action ${String(i)}`,
      expected: `expected ${String(i)}`,
    }));
    const result = createTestCaseSchema.safeParse({ title: "Test case", steps });
    expect(result.success).toBe(false);
  });

  it("accepts steps array of exactly 200 entries", () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({
      action: `action ${String(i)}`,
      expected: `expected ${String(i)}`,
    }));
    const result = createTestCaseSchema.safeParse({ title: "Test case", steps });
    expect(result.success).toBe(true);
  });

  it("rejects a step missing the action field (validates ordered steps structure)", () => {
    const result = createTestCaseSchema.safeParse({
      title: "Test case",
      steps: [{ expected: "something" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a step missing the expected field", () => {
    const result = createTestCaseSchema.safeParse({
      title: "Test case",
      steps: [{ action: "click button" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("TestManagementService — createSuite parent FK validation", () => {
  const OWNER_ORG = "org-owner";

  it("throws NotFoundException when parentId does not belong to the project", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, managerMembershipId: null }) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;

    const svc = new TestManagementService(db, makeAccessGranted());
    await expect(
      svc.createSuite(makeU(OWNER_ORG), 1, { name: "Child Suite", parentId: 99 }),
    ).rejects.toThrow(NotFoundException);
  });
});
