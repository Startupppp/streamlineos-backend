import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { KbContentGapService } from "./kb-content-gap.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  SupportKnowledgeGapStatus,
  type SupportKnowledgeGapStatusType,
} from "../../../db/schema/support/support-kb-gap";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

const user: CurrentUserContext = {
  userId: "u1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
} as unknown as CurrentUserContext;

const GAP_ROW: {
  id: number;
  clusterKey: string;
  status: SupportKnowledgeGapStatusType;
  proposedArticleId: number | null;
  draftedBy: string;
  dismissalReason: string | null;
  updatedAt: Date;
} = {
  id: 1,
  clusterKey: "how do I reset my password",
  status: SupportKnowledgeGapStatus.OPEN,
  proposedArticleId: null,
  draftedBy: "u2",
  dismissalReason: null,
  updatedAt: new Date("2026-01-01"),
};

const PAGE_ROW = { id: 42 };

function buildGapInsertDb(rows: typeof GAP_ROW[]): never {
  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as never;
}

function buildCreateFixDb(
  pageRows: typeof PAGE_ROW[],
  gapRows: typeof GAP_ROW[],
): never {
  const mockInsert = jest
    .fn()
    .mockImplementationOnce(() => ({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(pageRows),
      }),
    }))
    .mockImplementationOnce(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(gapRows),
        }),
      }),
    }));
  return { insert: mockInsert } as never;
}

async function makeService(db: never): Promise<KbContentGapService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      KbContentGapService,
      { provide: DRIZZLE, useValue: db },
      { provide: KnowledgeAuthorizationService, useValue: { assertSpaceAccess: async () => ({ via: "space" }) } },
    ],
  }).compile();
  return moduleRef.get(KbContentGapService);
}

describe("KbContentGapService.assignGap", () => {
  it("returns the gap row when RETURNING yields one row", async () => {
    const service = await makeService(buildGapInsertDb([GAP_ROW]));

    const result = await service.assignGap(user, {
      query: "how do I reset my password",
      assigneeUserId: "u2",
    });

    expect(result).toEqual(GAP_ROW);
  });

  it("throws NotFoundException when RETURNING is empty", async () => {
    const service = await makeService(buildGapInsertDb([]));

    await expect(
      service.assignGap(user, {
        query: "how do I reset my password",
        assigneeUserId: "u2",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("KbContentGapService.dismissGap", () => {
  const dismissedRow = {
    ...GAP_ROW,
    status: SupportKnowledgeGapStatus.DISMISSED,
    dismissalReason: "already covered",
  };

  it("returns the gap row when RETURNING yields one row", async () => {
    const service = await makeService(buildGapInsertDb([dismissedRow]));

    const result = await service.dismissGap(user, {
      query: "how do I reset my password",
      reason: "already covered",
    });

    expect(result.status).toBe(SupportKnowledgeGapStatus.DISMISSED);
  });

  it("throws NotFoundException when RETURNING is empty", async () => {
    const service = await makeService(buildGapInsertDb([]));

    await expect(
      service.dismissGap(user, {
        query: "how do I reset my password",
        reason: "already covered",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("KbContentGapService.createFix", () => {
  const draftedRow = {
    ...GAP_ROW,
    status: SupportKnowledgeGapStatus.DRAFTED,
    proposedArticleId: 42,
  };

  it("returns the gap row when both inserts succeed", async () => {
    const service = await makeService(buildCreateFixDb([PAGE_ROW], [draftedRow]));

    const result = await service.createFix(user, {
      query: "how do I reset my password",
      spaceId: 1,
    });

    expect(result).toEqual(draftedRow);
  });

  it("throws NotFoundException when the page RETURNING is empty", async () => {
    const service = await makeService(buildCreateFixDb([], [draftedRow]));

    await expect(
      service.createFix(user, {
        query: "how do I reset my password",
        spaceId: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when the gap RETURNING is empty after a successful page insert", async () => {
    const service = await makeService(buildCreateFixDb([PAGE_ROW], []));

    await expect(
      service.createFix(user, {
        query: "how do I reset my password",
        spaceId: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
