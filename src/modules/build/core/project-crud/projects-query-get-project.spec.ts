import { NotFoundException } from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../../../common/http/api-exceptions";
import { ProjectsQueryService } from "./projects-query.service";
import { resolveProjectAccess } from "./project-access";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

jest.mock("./project-access");
const mockResolveProjectAccess = jest.mocked(resolveProjectAccess);

function makeUser(orgId = "org-1"): CurrentUserContext {
  return {
    orgId,
    userId: "u-1",
    isOrgOwner: false,
    principal: { kind: "human-session" as const, membershipId: 7, isOrgOwner: false },
    role: "MEMBER" as const,
    sessionId: "s-1",
    tokenScopes: null,
  } as unknown as CurrentUserContext;
}

function makeDb(projectRow: unknown) {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
    },
    select: jest.fn(),
  } as unknown as Db;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

function makeAudit(): AuditService {
  return { log: jest.fn() } as unknown as AuditService;
}

describe("ProjectsQueryService.getProject — routes the access check through resolveProjectAccess", () => {
  beforeEach(() => jest.resetAllMocks());

  it("throws ProjectsForbiddenProjectException (403) when resolveProjectAccess denies access, preserving the in-tenant denial code", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const svc = new ProjectsQueryService(makeDb(null), makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).rejects.toThrow(ProjectsForbiddenProjectException);
  });

  it("returns the project when resolveProjectAccess grants access (positive control: authorised member sees project)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const project = { id: 1, name: "P", statuses: [], members: [] };
    const svc = new ProjectsQueryService(makeDb(project), makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).resolves.toEqual(project);
  });

  it("throws ProjectsNotFoundException (404) when the project does not exist in the org, so a cross-tenant probe gets 404 not 403", async () => {
    mockResolveProjectAccess.mockRejectedValue(new NotFoundException("Project not found"));
    const svc = new ProjectsQueryService(makeDb(null), makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).rejects.toThrow(ProjectsNotFoundException);
  });

  it("calls resolveProjectAccess exactly once per getProject call so the access decision has a single authoritative source", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "OWNER" });
    const project = { id: 5, name: "X", statuses: [], members: [] };
    const svc = new ProjectsQueryService(makeDb(project), makeAudit(), makeAccess());
    await svc.getProject(makeUser(), 5);
    expect(mockResolveProjectAccess).toHaveBeenCalledTimes(1);
  });
});
