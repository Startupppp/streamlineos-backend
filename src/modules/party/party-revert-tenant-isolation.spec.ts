import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { PartyRevertService } from "./party-revert.service";

jest.mock("./party-legacy-writer", () => ({
  updatePartyWithMirror: jest.fn().mockResolvedValue(undefined),
  restorePartyWithMirror: jest.fn().mockResolvedValue(undefined),
  refreshPartyMirrors: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./party-legacy-employer", () => ({
  refreshEmployerColumns: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./party-identifiers", () => ({
  restoreIdentifiers: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./party-merge-legacy-ids", () => ({
  repointLegacyIds: jest.fn().mockResolvedValue(undefined),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";
const MERGE_ID = "merge-uuid-1";

function makeSelectDb(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    limit: jest.fn(),
  };
  chain.limit.mockReturnValue(chain);
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue({ where });
  return { where, from };
}

describe("PartyRevertService — cross-tenant isolation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("revert: throws NotFoundException for a merge record in a different org (deny)", async () => {
    const { where, from } = makeSelectDb([]);
    const updateWhere = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    } as unknown as Db;
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new PartyRevertService(db, audit);
    await expect(svc.revert(ATTACKER, MERGE_ID)).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("revert: resolves and audits for the owning org (control)", async () => {
    const mergeRow = {
      partyMergeId: MERGE_ID,
      survivorPartyId: "sp-1",
      mergedPartyId: "mp-1",
      organizationId: OWNER,
      decidedBy: "USER",
      revertedAt: null,
      snapshot: {
        survivorBefore: { name: "Survivor Inc" },
        mergedBefore: { name: "Merged Co" },
        movedContactIds: [],
        addedRoles: [],
        movedIdentifierIds: [],
        movedEmployeePartyIds: [],
        movedLegacyIds: { lead: [], client: [], contact: [], organisation: [] },
      },
    };
    const { where, from } = makeSelectDb([mergeRow]);
    const updateWhere = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    } as unknown as Db;
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new PartyRevertService(db, audit);
    const result = await svc.revert(OWNER, MERGE_ID, "actor-1");
    expect(result.survivorPartyId).toBe("sp-1");
    expect(result.restoredPartyId).toBe("mp-1");
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});
