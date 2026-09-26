import { NotFoundException } from "@nestjs/common";
import { ClientPortalManagementService } from "./client-portal-management.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeU(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ClientPortalManagementService.getSettings — publication state gate", () => {
  it("returns portalPublishedAt=null and grantCount=0 when project has no publication state and no active grants", async () => {
    let selectCount = 0;
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const idx = selectCount;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                if (idx === 1) return Promise.resolve([{ portalPublishedAt: null }]);
                return Promise.resolve([]);
              }),
            }),
          }),
        };
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    const result = await svc.getSettings(makeU("org-1"), 1);
    expect(result.portalPublishedAt).toBeNull();
    expect(result.grantCount).toBe(0);
  });

  it("returns portalPublishedAt timestamp when portal is published", async () => {
    const publishedAt = new Date("2025-01-01T00:00:00Z");
    let selectCount = 0;
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const idx = selectCount;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                if (idx === 1) return Promise.resolve([{ portalPublishedAt: publishedAt }]);
                return Promise.resolve([]);
              }),
            }),
          }),
        };
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    const result = await svc.getSettings(makeU("org-1"), 1);
    expect(result.portalPublishedAt).toEqual(publishedAt);
  });

  it("throws NotFoundException when project does not exist in tenant", async () => {
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    await expect(svc.getSettings(makeU("org-1"), 999)).rejects.toThrow(NotFoundException);
  });
});

describe("ClientPortalManagementService.publishPortal — lifecycle gate: sets portal_published_at", () => {
  it("sets portalPublishedAt to a recent timestamp on publish", async () => {
    const now = new Date();
    let updateCalled = false;
    let selectCount = 0;

    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ portalPublishedAt: now }]),
          }),
        }),
      }),
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        };
      }),
    } as unknown as Db;

    (db.update as jest.Mock).mockImplementation(() => {
      updateCalled = true;
      return {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ portalPublishedAt: now }]),
          }),
        }),
      };
    });

    const svc = new ClientPortalManagementService(db, mockAccess);
    const result = await svc.publishPortal(makeU("org-1"), 1);
    expect(updateCalled).toBe(true);
    expect(result.portalPublishedAt).toEqual(now);
  });

  it("throws NotFoundException when publish targets a missing project", async () => {
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    await expect(svc.publishPortal(makeU("org-1"), 999)).rejects.toThrow(NotFoundException);
  });
});

describe("ClientPortalManagementService.unpublishPortal — lifecycle gate: clears portal_published_at", () => {
  it("sets portalPublishedAt to null on unpublish", async () => {
    let selectCount = 0;
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ portalPublishedAt: null }]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    const result = await svc.unpublishPortal(makeU("org-1"), 1);
    expect(result.portalPublishedAt).toBeNull();
    expect(result.grantCount).toBe(0);
    void selectCount;
  });

  it("throws NotFoundException when unpublish targets a missing project", async () => {
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ClientPortalManagementService(db, mockAccess);
    await expect(svc.unpublishPortal(makeU("org-1"), 999)).rejects.toThrow(NotFoundException);
  });
});
