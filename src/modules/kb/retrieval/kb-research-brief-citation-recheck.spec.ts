import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbResearchBriefService } from "./kb-research-brief.service";
import type { KbCitationVisibilityService } from "./kb-citation-visibility.service";

const STORED_CITATIONS = [
  { kind: "article", id: 1, title: "Open handbook", href: "/support/kb/1", updatedAt: null },
  { kind: "article", id: 2, title: "Board compensation memo", href: "/support/kb/2", updatedAt: null },
  { kind: "page", id: 7, title: "Open page", href: "/support/kb/pages/7", updatedAt: null },
  { kind: "source", id: 9, title: "Revoked upload", href: null, updatedAt: null },
];

function makeDb(citations: unknown) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: 1,
              orgId: "org-1",
              userId: "user-1",
              topic: "compensation",
              spaceId: null,
              status: "complete",
              jobId: 4,
              sourceCount: 4,
              report: "the report body",
              citations,
              errorMessage: null,
              rating: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ]),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeVisibility(visibleIds: number[]) {
  return {
    partitionVisible: jest.fn().mockResolvedValue({
      visible: (ref: { id: number }) => visibleIds.includes(ref.id),
    }),
  } as unknown as KbCitationVisibilityService;
}

const user = {
  orgId: "org-1",
  userId: "user-1",
  principal: humanSessionPrincipal(1, false),
} as never;

describe("KbResearchBriefService.getById — citations are re-checked on every read", () => {
  it("refuses the whole brief when any cited document is no longer readable", async () => {
    const visibility = makeVisibility([1, 7]);
    const svc = new KbResearchBriefService(makeDb(STORED_CITATIONS), {} as never, visibility);

    await expect(svc.getById(user, 1)).rejects.toThrow("no longer accessible");
  });

  it("the report prose never reaches a reader who lost access to a source it was written from", async () => {
    const visibility = makeVisibility([]);
    const svc = new KbResearchBriefService(makeDb(STORED_CITATIONS), {} as never, visibility);

    await expect(svc.getById(user, 1)).rejects.toThrow("no longer accessible");
  });

  it("BITE: the same stored brief returns every citation when access still holds", async () => {
    const visibility = makeVisibility([1, 2, 7, 9]);
    const svc = new KbResearchBriefService(makeDb(STORED_CITATIONS), {} as never, visibility);

    const brief = await svc.getById(user, 1);

    expect(brief.citations?.map((c) => c.id)).toEqual([1, 2, 7, 9]);
  });

  it("re-checks against the reader, passing every stored reference to the resolver", async () => {
    const visibility = makeVisibility([]);
    const svc = new KbResearchBriefService(makeDb(STORED_CITATIONS), {} as never, visibility);

    await expect(svc.getById(user, 1)).rejects.toThrow();

    expect(visibility.partitionVisible).toHaveBeenCalledWith(user, [
      { kind: "article", id: 1 },
      { kind: "article", id: 2 },
      { kind: "page", id: 7 },
      { kind: "source", id: 9 },
    ]);
  });

  it("leaves a brief with no citations alone", async () => {
    const visibility = makeVisibility([]);
    const svc = new KbResearchBriefService(makeDb(null), {} as never, visibility);

    const brief = await svc.getById(user, 1);

    expect(brief.citations).toBeNull();
    expect(visibility.partitionVisible).not.toHaveBeenCalled();
  });

});
