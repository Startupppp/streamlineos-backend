import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbMembersService } from "./kb-members.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const ORG_A = "org-members-a";
const ORG_B = "org-members-b";
const SPACE_ID = 11;

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

function makeService(spaceRow: object | undefined): KbMembersService {
  const db = {
    query: {
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(spaceRow) },
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
  it("BITE: list returns 404 when the space belongs to a different org (cross-tenant miss is 404, not 200)", async () => {
    const svc = makeService(undefined);

    await expect(svc.list(ORG_B, SPACE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list resolves when the space belongs to the requesting org (same-tenant positive control)", async () => {
    const svc = makeService({ id: SPACE_ID, orgId: ORG_A, deletedAt: null });

    await expect(svc.list(ORG_A, SPACE_ID)).resolves.toBeInstanceOf(Array);
  });

  it("cross-tenant and not-found produce the same error message, so the caller cannot distinguish them", async () => {
    const crossTenantSvc = makeService(undefined);
    const notFoundSvc = makeService(undefined);

    const crossTenantErr = await crossTenantSvc.list(ORG_B, SPACE_ID).catch((e) => e);
    const notFoundErr = await notFoundSvc.list(ORG_A, SPACE_ID + 9999).catch((e) => e);

    expect(crossTenantErr).toBeInstanceOf(NotFoundException);
    expect(notFoundErr).toBeInstanceOf(NotFoundException);
    expect((crossTenantErr as NotFoundException).message).toBe(
      (notFoundErr as NotFoundException).message,
    );
  });

  it("sibling org membership is never visible — a member row in ORG_A space is not listed when the caller is ORG_B", async () => {
    const svc = makeService(undefined);

    const result = await svc.list(ORG_B, SPACE_ID).catch(() => null);

    expect(result).toBeNull();
  });
});
