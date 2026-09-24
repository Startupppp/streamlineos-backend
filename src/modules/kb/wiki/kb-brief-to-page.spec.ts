import { ConflictException } from "@nestjs/common";
import { KbBriefToPageService } from "./kb-brief-to-page.service";

const USER = {
  orgId: "org-1",
  userId: "user-1",
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
} as never;

function makeBrief(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    topic: "Competitor pricing review",
    spaceId: 9,
    status: "completed",
    report: "First finding\n\nSecond finding",
    citations: [],
    ...overrides,
  };
}

function makeHarness(brief: Record<string, unknown>) {
  const briefs = { getById: jest.fn().mockResolvedValue(brief) };
  const pages = {
    create: jest.fn().mockResolvedValue({ id: 42 }),
    update: jest.fn().mockResolvedValue({ id: 42 }),
  };
  return {
    briefs,
    pages,
    svc: new KbBriefToPageService(briefs as never, pages as never),
  };
}

describe("KbBriefToPageService", () => {
  it("creates a page from a completed brief and returns its id", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    const result = await svc.convert(USER, 5, {}, false);

    expect(result.pageId).toBe(42);
    expect(pages.create).toHaveBeenCalledTimes(1);
  });

  it("resolves the brief through the brief service, so its tenant and citation checks still run", async () => {
    const { svc, briefs } = makeHarness(makeBrief());

    await svc.convert(USER, 5, {}, false);

    expect(briefs.getById).toHaveBeenCalledWith(USER, 5);
  });

  it("titles the page from the brief topic rather than leaving it blank", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    await svc.convert(USER, 5, {}, false);

    expect(pages.create.mock.calls[0][1].title).toBe("Competitor pricing review");
  });

  it("writes the report into the page body, so the conversion is not an empty page", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    await svc.convert(USER, 5, {}, false);

    const content = pages.update.mock.calls[0][2].content as {
      content: { children: { text: string }[] }[];
    };
    const paragraphs = content.content.map((node) => node.children[0].text);
    expect(paragraphs).toContain("First finding");
    expect(paragraphs).toContain("Second finding");
  });

  it("falls back to the brief's own space when the caller names none", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    await svc.convert(USER, 5, {}, false);

    expect(pages.create.mock.calls[0][1].spaceId).toBe(9);
  });

  it("prefers an explicitly requested space over the brief's own", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    await svc.convert(USER, 5, { spaceId: 77 }, false);

    expect(pages.create.mock.calls[0][1].spaceId).toBe(77);
  });

  it("refuses a brief that is still running, because there is no report to convert", async () => {
    const { svc, pages } = makeHarness(makeBrief({ status: "running", report: null }));

    await expect(svc.convert(USER, 5, {}, false)).rejects.toBeInstanceOf(ConflictException);
    expect(pages.create).not.toHaveBeenCalled();
  });

  it("refuses a completed brief whose report is empty, rather than creating a blank page", async () => {
    const { svc, pages } = makeHarness(makeBrief({ report: null }));

    await expect(svc.convert(USER, 5, {}, false)).rejects.toBeInstanceOf(ConflictException);
    expect(pages.create).not.toHaveBeenCalled();
  });

  it("passes the caller's manage standing through to the page write instead of assuming it", async () => {
    const { svc, pages } = makeHarness(makeBrief());

    await svc.convert(USER, 5, {}, true);

    expect(pages.update.mock.calls[0][3]).toBe(true);
  });
});
