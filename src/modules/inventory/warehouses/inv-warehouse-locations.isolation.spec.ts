import { NotFoundException } from "@nestjs/common";
import { InvWarehouseLocationsService } from "./inv-warehouse-locations.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";

const ATTACKER_ORG = "org-attacker";
const VICTIM_ORG = "org-victim";

const mockCache = {
  cachedVersioned: jest.fn((_key: string, _sub: string, fn: () => Promise<unknown>, _ttl: number) => fn()),
} as unknown as CacheService;

function makeQuery(resolved: unknown = undefined) {
  return {
    invWarehouses: {
      findFirst: jest.fn().mockResolvedValue(resolved),
    },
    invLocations: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeDb(queryResult: unknown = undefined): Db {
  return {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) })),
    query: makeQuery(queryResult),
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("InvWarehouseLocationsService — cross-tenant isolation", () => {
  it("createLocation throws NotFoundException when warehouseId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb(undefined);
    const svc = new InvWarehouseLocationsService(db, mockCache);
    await expect(svc.createLocation(ATTACKER_ORG, 9999, { code: "A1", name: "Aisle 1" })).rejects.toThrow(NotFoundException);
  });

  it("getWarehouseStock throws NotFoundException when warehouseId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb(undefined);
    const svc = new InvWarehouseLocationsService(db, mockCache);
    await expect(svc.getWarehouseStock(ATTACKER_ORG, 9999, 1, 20)).rejects.toThrow(NotFoundException);
  });

  it("listLocations scopes WHERE to the requesting orgId — cross-org isolation", async () => {
    const orgIdsSeen: string[] = [];
    const db = {
      query: {
        invWarehouses: { findFirst: jest.fn().mockResolvedValue(undefined) },
        invLocations: {
          findMany: jest.fn(({ where }: { where?: unknown }) => {
            if (where && typeof where === "object") {
              const vals: unknown[] = [];
              function walk(v: unknown, seen = new Set<object>()): void {
                if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") { vals.push(v); return; }
                if (Array.isArray(v)) { v.forEach((x) => walk(x, seen)); return; }
                if (typeof v !== "object" || seen.has(v as object)) return;
                seen.add(v as object);
                const rec = v as Record<string, unknown>;
                if (rec["queryChunks"]) walk(rec["queryChunks"], seen);
                if (Object.prototype.hasOwnProperty.call(rec, "value")) walk(rec["value"], seen);
              }
              walk(where);
              vals.filter((x) => typeof x === "string").forEach((s) => orgIdsSeen.push(s as string));
            }
            return Promise.resolve([]);
          }),
        },
      },
    } as unknown as Db;

    const svc = new InvWarehouseLocationsService(db, mockCache);
    await svc.listLocations(ATTACKER_ORG, 1);
    expect(orgIdsSeen).toContain(ATTACKER_ORG);
    expect(orgIdsSeen).not.toContain(VICTIM_ORG);
  });
});
