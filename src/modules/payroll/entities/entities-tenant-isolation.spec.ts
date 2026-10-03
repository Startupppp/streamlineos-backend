import type { Db } from "../../../db/drizzle.module";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PayrollEntitiesService } from "./entities.service";
import { updateEntitySchema } from "./dto/entities.schemas";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("PayrollEntitiesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(rows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("returns only attacker-org entities (empty) — orgId scoped (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PayrollEntitiesService(db);
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns entities for the owning org (same-tenant control)", async () => {
    const entity = { id: 1, orgId: OWNER_ORG, legalName: "Org Ltd" };
    const { db } = makeDb([entity]);
    const svc = new PayrollEntitiesService(db);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});

describe("PayrollEntitiesService.update — statutory filing details, cross-tenant isolation", () => {
  function makeUpdateDb(result: unknown[] | Error) {
    const sets: Record<string, unknown>[] = [];
    const wheres: unknown[] = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: (predicate: unknown) => {
              wheres.push(predicate);
              return {
                returning: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
              };
            },
          };
        },
      }),
    } as unknown as Db;
    return { db, sets, wheres };
  }

  it("404s another org's entity (cross-tenant isolation) and scopes the write by org", async () => {
    const { db, wheres } = makeUpdateDb([]);

    await expect(new PayrollEntitiesService(db).update("org-attacker", 9, { pan: "ABCDE1234F" })).rejects.toThrow(NotFoundException);
    expect(sqlValues(wheres[0])).toEqual(expect.arrayContaining(["org-attacker", 9]));
  });

  it("writes only the supplied fields and returns the row", async () => {
    const row = { id: 9, orgId: "org-owner", pan: "ABCDE1234F", esiCode: null };
    const { db, sets } = makeUpdateDb([row]);

    await expect(new PayrollEntitiesService(db).update("org-owner", 9, { pan: "ABCDE1234F", esiCode: null })).resolves.toBe(row);
    expect(sets[0]).toEqual({ pan: "ABCDE1234F", esiCode: null });
  });

  it("maps a legal-name clash to 409", async () => {
    const { db } = makeUpdateDb(Object.assign(new Error("dup"), { code: "23505" }));

    await expect(new PayrollEntitiesService(db).update("org-owner", 9, { legalName: "Taken Ltd" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("validates filing formats", () => {
    expect(updateEntitySchema.safeParse({ pan: "ABCDE1234F", tan: "ABCD12345E", pfEstablishmentCode: "MHBAN0012345000", esiCode: "12345678901234567", ptStateCode: "KA", stateCode: "KA" }).success).toBe(true);
    expect(updateEntitySchema.safeParse({ pan: "abcde1234f" }).success).toBe(false);
    expect(updateEntitySchema.safeParse({ tan: "ABCDE1234F" }).success).toBe(false);
    expect(updateEntitySchema.safeParse({ pfEstablishmentCode: "MH/1" }).success).toBe(false);
    expect(updateEntitySchema.safeParse({ esiCode: "1234" }).success).toBe(false);
    expect(updateEntitySchema.safeParse({ ptStateCode: "Kar" }).success).toBe(false);
    expect(updateEntitySchema.safeParse({}).success).toBe(false);
    expect(updateEntitySchema.safeParse({ countryCode: "US" }).success).toBe(false);
  });
});
