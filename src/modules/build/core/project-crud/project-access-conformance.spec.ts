import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { assertProjectAccess, assertCanManageProject } from "./project-access";
import type { Db } from "../../../../db/drizzle.types";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

function makeDb(opts: {
  project: { managerMembershipId: number | null } | undefined;
  memberRows?: { role: string }[];
  teamRows?: { id: number }[];
}) {
  let selectIndex = 0;
  const thenable = (rows: readonly unknown[]) => {
    const chain: Record<string, unknown> = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    return chain;
  };
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(opts.project) },
    },
    select: jest.fn(() => {
      selectIndex += 1;
      return thenable(selectIndex === 1 ? (opts.memberRows ?? []) : (opts.teamRows ?? []));
    }),
  } as unknown as Db;
}

function makeAccess(permissions: string[] = []): Pick<AccessService, "resolveUserPermissions"> {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(permissions)),
  } as Pick<AccessService, "resolveUserPermissions">;
}

function user(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    orgId: "org-1",
    userId: "u-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
    ...overrides,
  } as CurrentUserContext;
}

const PROJECT_WITH_OTHER_MANAGER = { managerMembershipId: 99 };
const PROJECT_MANAGED_BY_CALLER = { managerMembershipId: 7 };
const PROJECT_NO_MANAGER = { managerMembershipId: null };

describe("project-access conformance matrix — assertProjectAccess", () => {
  describe("cross-tenant miss: project not in caller org → 404 regardless of actor standing", () => {
    it("throws NotFoundException for an org owner when the project is absent from their org", async () => {
      const db = makeDb({ project: undefined });
      await expect(
        assertProjectAccess(db, makeAccess(), user({ isOrgOwner: true }), 1),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for an org admin (build:manage) when the project is absent from their org", async () => {
      const db = makeDb({ project: undefined });
      await expect(
        assertProjectAccess(db, makeAccess(["build:manage"]), user(), 1),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("allowed actors: org owner, org admin, manager, ADMIN member, CONTRIBUTOR member, team member", () => {
    it("resolves for an org owner on a project in their org", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER });
      await expect(
        assertProjectAccess(db, makeAccess(), user({ isOrgOwner: true }), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a holder of build:manage (org admin) without querying memberships", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER });
      await expect(
        assertProjectAccess(db, makeAccess(["build:manage"]), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for the project manager identified by managerMembershipId in the project row", async () => {
      const db = makeDb({ project: PROJECT_MANAGED_BY_CALLER });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a direct project member with ADMIN role", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [{ role: "ADMIN" }] });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a direct project member with CONTRIBUTOR role", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [{ role: "CONTRIBUTOR" }] });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a team member even without direct project membership", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [], teamRows: [{ id: 1 }] });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });
  });

  describe("denied actors: outsider in same org → 403 (not 404, because project exists)", () => {
    it("throws ForbiddenException for an in-org user with no membership or team access", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [], teamRows: [] });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("does not throw NotFoundException for an outsider — that would leak project existence", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [], teamRows: [] });
      await expect(
        assertProjectAccess(db, makeAccess(), user(), 1),
      ).rejects.not.toThrow(NotFoundException);
    });
  });
});

describe("project-access conformance matrix — assertCanManageProject", () => {
  describe("cross-tenant miss: project not in caller org → 404", () => {
    it("throws NotFoundException for an org owner when the project is absent from their org", async () => {
      const db = makeDb({ project: undefined });
      await expect(
        assertCanManageProject(db, makeAccess(), user({ isOrgOwner: true }), 1),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for a plain user when the project is absent from their org", async () => {
      const db = makeDb({ project: undefined });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("allowed actors: org owner, org admin, project manager, ADMIN direct member", () => {
    it("resolves for an org owner on a project in their org", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER });
      await expect(
        assertCanManageProject(db, makeAccess(), user({ isOrgOwner: true }), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a holder of build:manage without checking project membership", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER });
      await expect(
        assertCanManageProject(db, makeAccess(["build:manage"]), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for the project manager identified by managerMembershipId", async () => {
      const db = makeDb({ project: PROJECT_MANAGED_BY_CALLER });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a direct project member with ADMIN role", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [{ role: "ADMIN" }] });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).resolves.toBeUndefined();
    });
  });

  describe("denied actors: CONTRIBUTOR member, team member, outsider → 403 (project exists)", () => {
    it("throws ForbiddenException for a direct project member with CONTRIBUTOR role", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [{ role: "CONTRIBUTOR" }] });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for a team member who has view access but not management authority", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [], teamRows: [{ id: 1 }] });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for an in-org user with no project relationship at all", async () => {
      const db = makeDb({ project: PROJECT_NO_MANAGER, memberRows: [], teamRows: [] });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("does not leak project existence for a denied in-org user — denial is 403 not 404", async () => {
      const db = makeDb({ project: PROJECT_WITH_OTHER_MANAGER, memberRows: [], teamRows: [] });
      await expect(
        assertCanManageProject(db, makeAccess(), user(), 1),
      ).rejects.not.toThrow(NotFoundException);
    });
  });
});
