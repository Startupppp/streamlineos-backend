import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbMembersService } from "./kb-members.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const ORG_A = "org-members-a";
const ORG_B = "org-members-b";
const SPACE_ID = 11;

const ORG_A_SPACE = { id: SPACE_ID, orgId: ORG_A, deletedAt: null };

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

function makeSpaceFindFirst(): jest.Mock {
  return jest.fn().mockImplementation(async (opts: { where?: unknown } = {}) => {
    const vals = sqlValues(opts.where);
    if (vals.includes(ORG_B)) return undefined;
    if (vals.includes(ORG_A) && vals.includes(SPACE_ID)) return ORG_A_SPACE;
    if (vals.includes(ORG_A)) return undefined;
    return ORG_A_SPACE;
  });
}

function makeSelectChain(rows: unknown[] = []): object {
  const chain: object = Object.assign(Promise.resolve(rows), {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  });
  return chain;
}

function makeService(): KbMembersService {
  const db = {
    query: {
      kbSpaces: { findFirst: makeSpaceFindFirst() },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      kbSpaceMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue(makeSelectChain([])),
  } as unknown as Db;
  const access = {
    invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAccessService;
  const indexing = {
    bumpSpaceAclRevision: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbIndexingService;
  return new KbMembersService(db, access, indexing);
}

describe("KbMembersService — tenant isolation", () => {
  it("BITE: list returns 404 when the space belongs to a different org — removing the orgId filter from assertSpaceExists causes this to resolve instead of rejecting", async () => {
    const svc = makeService();

    await expect(svc.list(ORG_B, SPACE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list resolves to a CursorPage when the space belongs to the requesting org (positive control — the same space lookup succeeds for the owning org)", async () => {
    const svc = makeService();

    const result = await svc.list(ORG_A, SPACE_ID);

    expect(result).toHaveProperty("data");
    expect(Array.isArray((result as { data: unknown }).data)).toBe(true);
  });

  it("cross-tenant miss and not-found produce the same error message so the caller cannot distinguish them", async () => {
    const svc = makeService();

    const crossTenantErr = await svc.list(ORG_B, SPACE_ID).catch((e) => e);
    const notFoundErr = await svc.list(ORG_A, SPACE_ID + 9999).catch((e) => e);

    expect(crossTenantErr).toBeInstanceOf(NotFoundException);
    expect(notFoundErr).toBeInstanceOf(NotFoundException);
    expect((crossTenantErr as NotFoundException).message).toBe(
      (notFoundErr as NotFoundException).message,
    );
  });
});
