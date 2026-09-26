import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";

jest.mock("../../build/core/project-access", () => ({
  resolveProjectAccess: jest.fn(),
}));

import { resolveProjectAccess } from "../../build/core/project-access";
const mockResolveProjectAccess = resolveProjectAccess as jest.Mock;

describe("KbPagesService.create — project scoping", () => {
  const OUTSIDE_PROJECT_ID = 42;
  const MEMBER_PROJECT_ID = 7;
  const ORG_ID = "org-1";

  function makeUser() {
    return {
      orgId: ORG_ID,
      userId: "user-1",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 1 },
    } as never;
  }

  const notifications = {} as never;
  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;
  const auth = {} as never;
  const access = {} as never;

  function makeDb(projectId: number) {
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 100, orgId: ORG_ID, projectId }]),
      }),
    });

    const siblingSelectChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    return {
      query: {
        kbPageTemplates: { findFirst: jest.fn().mockResolvedValue(undefined) },
        kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockReturnValue(siblingSelectChain),
      insert,
    } as unknown as Db;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a projectId the caller is not a member of (cross-project write deny)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const db = makeDb(OUTSIDE_PROJECT_ID);
    const svc = new KbPagesService(db, notifications, planLimits, auth, access, {} as never);

    await expect(
      svc.create(makeUser(), { projectId: OUTSIDE_PROJECT_ID }),
    ).rejects.toThrow(NotFoundException);

    expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
  });

  it("creates the page when the caller is a member of the project (same-project control)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeDb(MEMBER_PROJECT_ID);
    const svc = new KbPagesService(db, notifications, planLimits, auth, access, {} as never);

    const result = await svc.create(makeUser(), { projectId: MEMBER_PROJECT_ID });

    expect(result).toHaveProperty("projectId", MEMBER_PROJECT_ID);
    expect((db as unknown as { insert: jest.Mock }).insert).toHaveBeenCalled();
  });

  it("skips the project access check when projectId is omitted (non-project page)", async () => {
    const db = makeDb(0);
    const svc = new KbPagesService(db, notifications, planLimits, auth, access, {} as never);

    await svc.create(makeUser(), {});

    expect(mockResolveProjectAccess).not.toHaveBeenCalled();
  });
});
