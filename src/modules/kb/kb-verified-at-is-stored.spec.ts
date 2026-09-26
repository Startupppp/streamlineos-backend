import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbArticlesService } from "./help-centre/kb-articles.service";
import { KbPageStatusService } from "./wiki/kb-page-status.service";

const ORG = "org-uuid-1";
const PAGE_ID = 7;

function makeUser(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-uuid-1",
    isOrgOwner: true,
    principal: { kind: "human-session", membershipId: 11 },
  } as unknown as CurrentUserContext;
}

interface Captured {
  db: Db;
  setPayload: () => Record<string, unknown>;
}

function captureUpdate(selectRow: Record<string, unknown>, returned: Record<string, unknown>): Captured {
  const set = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([returned]),
    }),
  });

  const db = {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(selectRow) } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([selectRow]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({ set }),
  } as unknown as Db;

  return {
    db,
    setPayload: () => (set.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>,
  };
}

describe("verification records the instant it happened, not a window to subtract later", () => {
  it("stores verifiedAt on the help-centre verify path", async () => {
    const before = Date.now();
    const captured = captureUpdate(
      { reviewIntervalDays: 90 },
      { id: PAGE_ID, orgId: ORG, verifiedAt: new Date() },
    );
    const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) };
    const events = { record: jest.fn().mockResolvedValue(undefined) };

    const svc = new KbArticlesService(captured.db, access as never, events as never);
    await svc.verify(makeUser(), PAGE_ID, { reviewIntervalDays: 90 } as never);

    const payload = captured.setPayload();
    const verifiedAt = payload["verifiedAt"];
    expect(verifiedAt).toBeInstanceOf(Date);
    expect((verifiedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(payload["verifiedUntil"]).toBeInstanceOf(Date);
  });

  it("stores verifiedAt on the wiki verify path, which writes a different window to verifiedUntil", async () => {
    const before = Date.now();
    const captured = captureUpdate(
      { id: PAGE_ID, contentType: "support_article" },
      { id: PAGE_ID, orgId: ORG, contentRevision: 1, aclRevision: 1 },
    );
    const auth = {
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: ORG, pageId: PAGE_ID, action: "edit", via: "admin" }),
    };

    const svc = new KbPageStatusService(captured.db, null as never, auth as never, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);
    await svc.verify(makeUser(), PAGE_ID, {} as never);

    const payload = captured.setPayload();
    const verifiedAt = payload["verifiedAt"];
    expect(verifiedAt).toBeInstanceOf(Date);
    expect((verifiedAt as Date).getTime()).toBeGreaterThanOrEqual(before);

    const verifiedUntil = payload["verifiedUntil"];
    expect(verifiedUntil).toBeInstanceOf(Date);
    expect((verifiedUntil as Date).getTime()).toBeGreaterThan((verifiedAt as Date).getTime());
  });

  it("writes windows that disagree, which is why verifiedAt cannot be derived from verifiedUntil", async () => {
    const helpCentre = captureUpdate(
      { reviewIntervalDays: 90 },
      { id: PAGE_ID, orgId: ORG, verifiedAt: new Date() },
    );
    const wiki = captureUpdate(
      { id: PAGE_ID, contentType: "support_article" },
      { id: PAGE_ID, orgId: ORG, contentRevision: 1, aclRevision: 1 },
    );

    await new KbArticlesService(
      helpCentre.db,
      { assertArticleEditable: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    ).verify(makeUser(), PAGE_ID, { reviewIntervalDays: 90 } as never);

    await new KbPageStatusService(
      wiki.db,
      null as never,
      {
        assertPageAccess: jest
          .fn()
          .mockResolvedValue({ orgId: ORG, pageId: PAGE_ID, action: "edit", via: "admin" }),
      } as never, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never).verify(makeUser(), PAGE_ID, {} as never);

    const spanOf = (payload: Record<string, unknown>): number =>
      (payload["verifiedUntil"] as Date).getTime() - (payload["verifiedAt"] as Date).getTime();

    expect(spanOf(helpCentre.setPayload())).not.toEqual(spanOf(wiki.setPayload()));
  });
});
