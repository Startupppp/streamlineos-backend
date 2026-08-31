import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrCustomFieldsService } from "../hr-custom-fields.service";

const ALL_SCOPE = "all" as const;
const OWN_SCOPE = "own" as const;

function makeChain(result: unknown = []): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    orderBy: jest.fn(),
    set: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
    values: jest.fn(),
    onConflictDoUpdate: jest.fn(),
    returning: jest.fn(),
  };

  for (const key of Object.keys(chain)) {
    if (!["limit", "orderBy", "onConflictDoUpdate", "returning"].includes(key)) {
      chain[key]!.mockReturnValue(chain);
    } else {
      chain[key]!.mockResolvedValue(result);
    }
  }

  (chain as unknown as { then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => unknown }).then =
    (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);

  return chain;
}

const defBase = {
  id: 1,
  orgId: "org-1",
  entityType: "employee",
  projectId: 0,
  key: "joining_bonus",
  label: "Joining Bonus Eligible",
  fieldType: "boolean",
  options: null,
  settings: null,
  isSensitive: false,
  isRequired: false,
  category: null,
  isActive: true,
  displayOrder: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function makeSvc(db: unknown): HrCustomFieldsService {
  return new HrCustomFieldsService(db as never);
}

describe("HrCustomFieldsService — validation on write", () => {
  it("rejects a number field when a non-number value is submitted", async () => {
    const numDef = { ...defBase, id: 2, key: "salary_band", fieldType: "number" };

    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([numDef]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 2, value: "not-a-number" }],
      }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a boolean field when a non-boolean value is submitted", async () => {
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([defBase]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 1, value: "yes" }],
      }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a required field when value is null", async () => {
    const reqDef = { ...defBase, isRequired: true };
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([reqDef]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 1, value: null }],
      }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a date field when value is not a valid ISO string", async () => {
    const dateDef = { ...defBase, id: 3, key: "birth_date", fieldType: "date" };
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([dateDef]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 3, value: "not-a-date" }],
      }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("HrCustomFieldsService — unknown key rejection", () => {
  it("rejects a fieldDefinitionId that does not exist in the org's active definitions", async () => {
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 999, value: true }],
      }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a sensitive field update without canManageSensitive", async () => {
    const sensitiveDef = { ...defBase, isSensitive: true };
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([sensitiveDef]);
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
    };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 1, value: true }],
      }, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("HrCustomFieldsService — containment filtering", () => {
  it("returns employment IDs where the field is present with the given value", async () => {
    const filterChain = makeChain([{ id: 10 }, { id: 20 }]);
    const db = { select: jest.fn().mockReturnValue(filterChain) };

    const svc = makeSvc(db);
    const ids = await svc.filterByCustomField(
      "org-1",
      "user-1",
      ALL_SCOPE,
      "employee",
      "joining_bonus",
      true,
    );

    expect(ids).toEqual([10, 20]);
  });

  it("returns employment IDs where the field has an explicit null value", async () => {
    const filterChain = makeChain([{ id: 5 }]);
    const db = { select: jest.fn().mockReturnValue(filterChain) };

    const svc = makeSvc(db);
    const ids = await svc.filterByCustomField(
      "org-1",
      "user-1",
      ALL_SCOPE,
      "employee",
      "joining_bonus",
      null,
    );

    expect(ids).toEqual([5]);
  });

  it("returns employment IDs where the field key is absent (value=undefined)", async () => {
    const filterChain = makeChain([{ id: 7 }, { id: 8 }]);
    const db = { select: jest.fn().mockReturnValue(filterChain) };

    const svc = makeSvc(db);
    const ids = await svc.filterByCustomField(
      "org-1",
      "user-1",
      ALL_SCOPE,
      "employee",
      "joining_bonus",
      undefined,
    );

    expect(ids).toEqual([7, 8]);
  });

  it("returns empty array when no employments match", async () => {
    const filterChain = makeChain([]);
    const db = { select: jest.fn().mockReturnValue(filterChain) };

    const svc = makeSvc(db);
    const ids = await svc.filterByCustomField(
      "org-1",
      "user-1",
      ALL_SCOPE,
      "employee",
      "joining_bonus",
      false,
    );

    expect(ids).toEqual([]);
  });
});

describe("HrCustomFieldsService — scope enforcement", () => {
  it("throws NotFoundException when the caller cannot read the employment", async () => {
    const scopeChain = makeChain([]);
    const db = { select: jest.fn().mockReturnValue(scopeChain) };

    const svc = makeSvc(db);
    await expect(
      svc.getEntityValues("org-1", "user-1", OWN_SCOPE, "employee", "99", false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when employment does not belong to the caller's org", async () => {
    const scopeChain = makeChain([]);
    const db = { select: jest.fn().mockReturnValue(scopeChain) };

    const svc = makeSvc(db);
    await expect(
      svc.upsertEntityValues("org-other", "user-1", ALL_SCOPE, "employee", "99", {
        values: [{ fieldDefinitionId: 1, value: true }],
      }, false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("HrCustomFieldsService — successful JSONB read", () => {
  it("maps stored JSONB values to definitions and marks absent keys as undefined", async () => {
    const def1 = { ...defBase, id: 1, key: "joining_bonus", fieldType: "boolean" };
    const def2 = { ...defBase, id: 2, key: "band", fieldType: "text" };

    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([def1, def2]);
    const empChain = makeChain([{ customFieldValues: { joining_bonus: true } }]);

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain)
        .mockReturnValueOnce(empChain),
    };

    const svc = makeSvc(db);
    const result = await svc.getEntityValues(
      "org-1",
      "user-1",
      ALL_SCOPE,
      "employee",
      "99",
      false,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.definition.key).toBe("joining_bonus");
    expect(result[0]?.value).toBe(true);
    expect(result[1]?.definition.key).toBe("band");
    expect(result[1]?.value).toBeUndefined();
  });

  it("redacts sensitive values when canViewSensitive is false", async () => {
    const sensitiveDef = { ...defBase, id: 1, key: "salary_note", isSensitive: true };

    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([sensitiveDef]);
    const empChain = makeChain([{ customFieldValues: { salary_note: "confidential" } }]);

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain)
        .mockReturnValueOnce(empChain),
    };

    const svc = makeSvc(db);
    const result = await svc.getEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", false);

    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("distinguishes a field with explicit null from a field that is absent", async () => {
    const def1 = { ...defBase, id: 1, key: "field_a", fieldType: "text" };
    const def2 = { ...defBase, id: 2, key: "field_b", fieldType: "text" };

    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([def1, def2]);
    const empChain = makeChain([{ customFieldValues: { field_a: null } }]);

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain)
        .mockReturnValueOnce(empChain),
    };

    const svc = makeSvc(db);
    const result = await svc.getEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", false);

    expect(result[0]?.value).toBeNull();
    expect(result[1]?.value).toBeUndefined();
  });
});

describe("HrCustomFieldsService — successful JSONB write", () => {
  it("calls db.update on hrEmployments with the merged JSONB patch", async () => {
    const scopeChain = makeChain([{ id: 99 }]);
    const defsChain = makeChain([defBase]);
    const updateChain = makeChain([]);

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(scopeChain)
        .mockReturnValueOnce(defsChain),
      update: jest.fn().mockReturnValue(updateChain),
    };

    const svc = makeSvc(db);
    await svc.upsertEntityValues("org-1", "user-1", ALL_SCOPE, "employee", "99", {
      values: [{ fieldDefinitionId: 1, value: true }],
    }, false);

    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
