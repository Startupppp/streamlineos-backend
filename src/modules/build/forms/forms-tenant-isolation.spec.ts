import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../../common/rbac/data-scope";
import { FormsService } from "./forms.service";
import { createFormSchema, updateFormSchema } from "./dto/forms.schemas";

describe("FormsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;
  const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

  beforeEach(() => {
    jest.mocked(mockAccess.resolveUserPermissions).mockResolvedValue(
      new Map<string, DataScope>([["build:manage", "all"]]),
    );
  });

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

  function makeDb(projectRow: unknown | null, formRow: unknown | null = null) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(formRow), findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException for getForm when project is from a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new FormsService(db, mockAccess, audit);
    await expect(svc.getForm(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for getForm when form not found for different org (cross-tenant isolation)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const db = makeDb(project, null);
    const svc = new FormsService(db, mockAccess, audit);
    await expect(svc.getForm(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns form for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Form" };
    const db = makeDb(project, form);
    const svc = new FormsService(db, mockAccess, audit);
    const result = await svc.getForm(makeU(OWNER_ORG), 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("FormsService — project-membership gate (BOLA)", () => {
  const audit = { log: jest.fn() } as never;

  function makeAccess(perms: Set<string> = new Set()): AccessService {
    return {
      resolveUserPermissions: jest.fn().mockResolvedValue(perms),
    } as unknown as AccessService;
  }

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

  function makeSelectChain(rows: unknown[]) {
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    return chain;
  }

  const u = makeU("org-1");

  it("REJECTS a non-member before any form read or mutation", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      update: jest.fn(),
    } as unknown as Db;
    const svc = new FormsService(mockDb, makeAccess(), audit);

    await expect(svc.listForms(u, 1, {})).rejects.toThrow(ForbiddenException);
    await expect(svc.getForm(u, 1, 1)).rejects.toThrow(ForbiddenException);
    await expect(svc.updateForm(u, 1, 1, { isPublic: true })).rejects.toThrow(ForbiddenException);
    await expect(svc.deleteForm(u, 1, 1)).rejects.toThrow(ForbiddenException);
    expect(mockDb.query.projectForms.findFirst).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("ALLOWS a direct project member", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValue(makeSelectChain([])),
    } as unknown as Db;
    const svc = new FormsService(mockDb, makeAccess(), audit);

    await expect(svc.listForms(u, 1, {})).resolves.toEqual({
      data: [],
      pagination: { limit: 100, hasMore: false, nextCursor: null },
    });
  });
});

describe("createFormSchema — conditional logic validation", () => {
  function baseForm(fields: unknown[]) {
    return { name: "F", fields, actions: [] };
  }

  function field(key: string, type: string, conditionalLogic?: unknown) {
    return { key, label: key, type, required: false, ...(conditionalLogic !== undefined ? { conditionalLogic } : {}) };
  }

  it("rejects fields whose conditional logic contains a direct cycle (A depends on B, B depends on A)", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("a", "text", { action: "show", match: "all", conditions: [{ fieldKey: "b", operator: "eq", value: "x" }] }),
        field("b", "text", { action: "show", match: "all", conditions: [{ fieldKey: "a", operator: "eq", value: "y" }] }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain("cycle");
  });

  it("rejects a field that references itself in conditional logic", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("a", "text", { action: "show", match: "all", conditions: [{ fieldKey: "a", operator: "eq", value: "x" }] }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain("itself");
  });

  it("rejects a condition that references an unknown field key", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("a", "text", { action: "show", match: "all", conditions: [{ fieldKey: "ghost", operator: "eq", value: "x" }] }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain("unknown field key");
  });

  it("rejects a numeric operator applied to a non-numeric field type", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("title", "text"),
        field("show_extra", "checkbox", { action: "show", match: "all", conditions: [{ fieldKey: "title", operator: "gt", value: 5 }] }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain("numeric");
  });

  it("accepts a valid non-cyclic conditional logic with a compatible numeric operator", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("score", "number"),
        field("feedback", "text", { action: "show", match: "all", conditions: [{ fieldKey: "score", operator: "gt", value: 3 }] }),
      ]),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a linear dependency chain without a cycle", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("a", "text"),
        field("b", "text", { action: "show", match: "all", conditions: [{ fieldKey: "a", operator: "eq", value: "x" }] }),
        field("c", "text", { action: "show", match: "all", conditions: [{ fieldKey: "b", operator: "eq", value: "y" }] }),
      ]),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an indirect cycle spanning three fields", () => {
    const result = createFormSchema.safeParse(
      baseForm([
        field("a", "text", { action: "show", match: "all", conditions: [{ fieldKey: "c", operator: "eq", value: "x" }] }),
        field("b", "text", { action: "show", match: "all", conditions: [{ fieldKey: "a", operator: "eq", value: "y" }] }),
        field("c", "text", { action: "show", match: "all", conditions: [{ fieldKey: "b", operator: "eq", value: "z" }] }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify((result as { error: unknown }).error)).toContain("cycle");
  });
});

describe("updateFormSchema — version field", () => {
  it("accepts a valid ISO datetime version string", () => {
    const result = updateFormSchema.safeParse({ name: "Updated", version: "2024-01-15T10:00:00.000Z" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-datetime version string", () => {
    const result = updateFormSchema.safeParse({ name: "Updated", version: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("passes when version is omitted", () => {
    const result = updateFormSchema.safeParse({ name: "Updated" });
    expect(result.success).toBe(true);
  });
});

describe("FormsService — optimistic concurrency (dirty-version conflict)", () => {
  const audit = { log: jest.fn() } as never;
  const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;
  const STORED_DATE = new Date("2024-01-15T10:00:00.000Z");
  const STALE_VERSION = "2024-01-14T09:00:00.000Z";

  beforeEach(() => {
    jest.mocked(mockAccess.resolveUserPermissions).mockResolvedValue(
      new Map<string, DataScope>([["build:manage", "all"]]),
    );
  });

  function makeU(): CurrentUserContext {
    return {
      userId: "user-1",
      orgId: "org-1",
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

  function makeFormRow(updatedAt: Date) {
    return {
      id: 1,
      orgId: "org-1",
      projectId: 5,
      formNumber: 1,
      name: "Test Form",
      description: null,
      type: "generic",
      fields: [],
      actions: [],
      isActive: true,
      isPublic: false,
      publicToken: null,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt,
      deletedAt: null,
    };
  }

  it("throws ConflictException when the provided version does not match stored updatedAt", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(makeFormRow(STORED_DATE)) },
      },
    } as unknown as Db;
    const svc = new FormsService(db, mockAccess, audit);

    await expect(
      svc.updateForm(makeU(), 5, 1, { name: "New Name", version: STALE_VERSION }),
    ).rejects.toThrow(ConflictException);
  });

  it("proceeds to the DB update when the provided version matches stored updatedAt", async () => {
    const updatedRow = makeFormRow(new Date());
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(makeFormRow(STORED_DATE)) },
      },
      update: updateMock,
    } as unknown as Db;
    const svc = new FormsService(db, mockAccess, audit);

    await expect(
      svc.updateForm(makeU(), 5, 1, { name: "New Name", version: STORED_DATE.toISOString() }),
    ).resolves.toBeDefined();

    expect(updateMock).toHaveBeenCalled();
  });

  it("proceeds without version check when version is omitted", async () => {
    const updatedRow = makeFormRow(new Date());
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(makeFormRow(STORED_DATE)) },
      },
      update: updateMock,
    } as unknown as Db;
    const svc = new FormsService(db, mockAccess, audit);

    await expect(
      svc.updateForm(makeU(), 5, 1, { name: "No Version" }),
    ).resolves.toBeDefined();

    expect(updateMock).toHaveBeenCalled();
  });
});
