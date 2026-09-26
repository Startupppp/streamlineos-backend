import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbSpacesService } from "./kb-spaces.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const ORG = "org-ask-indexed";
const SPACE_ID = 7;

function makeCountChain(count: number): object {
  return Object.assign(Promise.resolve([{ count }]), {
    from: jest.fn().mockImplementation(function (this: object) {
      return this;
    }),
    innerJoin: jest.fn().mockImplementation(function (this: object) {
      return this;
    }),
    where: jest.fn().mockImplementation(function (this: object) {
      return this;
    }),
  });
}

function makeDb(pageCounts: {
  pages: number;
  public: number;
  records: number;
  indexed: number;
}): Db {
  let callIndex = 0;
  const counts = [pageCounts.pages, pageCounts.public, pageCounts.records, pageCounts.indexed];

  return {
    query: {
      kbSpaces: {
        findFirst: jest.fn().mockResolvedValue({ id: SPACE_ID, orgId: ORG, deletedAt: null }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const idx = callIndex;
      callIndex += 1;
      const count = counts[idx] ?? 0;
      const chain = makeCountChain(count);
      return chain;
    }),
  } as unknown as Db;
}

function makeService(db: Db): KbSpacesService {
  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([SPACE_ID]),
    assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
    invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAccessService;
  const authz = { visiblePagePredicate: jest.fn().mockResolvedValue(undefined), resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [] }), invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockResolvedValue(undefined),  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService;
  return new KbSpacesService(db, {} as KbIndexingService, authz);
}

describe("KbSpacesService.archiveImpact — askIndexed reflects actual chunk presence", () => {
  it("BITE: reports askIndexed false when the space has pages but no indexed sources (pageCount > 0 is not a chunk measurement)", async () => {
    const db = makeDb({ pages: 5, public: 0, records: 0, indexed: 0 });
    const svc = makeService(db);

    const result = await svc.archiveImpact(ORG, SPACE_ID);

    expect(result.pageCount).toBe(5);
    expect(result.askIndexed).toBe(false);
  });

  it("reports askIndexed true when at least one source has chunks (positive control)", async () => {
    const db = makeDb({ pages: 3, public: 0, records: 0, indexed: 2 });
    const svc = makeService(db);

    const result = await svc.archiveImpact(ORG, SPACE_ID);

    expect(result.pageCount).toBe(3);
    expect(result.askIndexed).toBe(true);
  });

  it("reports askIndexed false for an empty space (zero pages, zero indexed)", async () => {
    const db = makeDb({ pages: 0, public: 0, records: 0, indexed: 0 });
    const svc = makeService(db);

    const result = await svc.archiveImpact(ORG, SPACE_ID);

    expect(result.pageCount).toBe(0);
    expect(result.askIndexed).toBe(false);
  });

  it("throws 404 when the space does not exist", async () => {
    const db = {
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
    } as unknown as Db;

    const svc = makeService(db);

    await expect(svc.archiveImpact(ORG, SPACE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
