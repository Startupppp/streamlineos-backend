import { NotFoundException } from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../../../common/http/api-exceptions";
import { ProjectsQueryService } from "./projects-query.service";
import { resolveProjectAccess } from "./project-access";
import { projectDetailSchema } from "../dto/build-project-detail-response.schemas";
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

function makeDb(projectRow: unknown, crmRows: unknown[] = []) {
  const limit = jest.fn<Promise<unknown[]>, [number]>().mockResolvedValue(crmRows);
  const where = jest.fn<{ limit: typeof limit }, [unknown]>(() => ({ limit }));
  const innerJoin = jest.fn<{ where: typeof where }, [unknown, unknown]>(() => ({ where }));
  const from = jest.fn<{ innerJoin: typeof innerJoin }, [unknown]>(() => ({ innerJoin }));
  const select = jest.fn<{ from: typeof from }, [unknown]>(() => ({ from }));
  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
    },
    select,
  } as unknown as Db;
  return { db, select, from, innerJoin, where, limit };
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

function makeAudit(): AuditService {
  return { log: jest.fn() } as unknown as AuditService;
}

function columnNamesIn(node: unknown, acc: string[] = []): string[] {
  if (node === null || typeof node !== "object") return acc;
  const n = node as Record<string, unknown>;
  if (typeof n["name"] === "string" && n["table"] !== undefined) acc.push(n["name"]);
  const chunks = n["queryChunks"];
  if (Array.isArray(chunks)) for (const chunk of chunks) columnNamesIn(chunk, acc);
  return acc;
}

describe("ProjectsQueryService.getProject — routes the access check through resolveProjectAccess", () => {
  beforeEach(() => jest.resetAllMocks());

  it("throws ProjectsForbiddenProjectException (403) when resolveProjectAccess denies access, preserving the in-tenant denial code", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const svc = new ProjectsQueryService(makeDb(null).db, makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).rejects.toThrow(ProjectsForbiddenProjectException);
  });

  it("returns the project when resolveProjectAccess grants access (positive control: authorised member sees project)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const project = { id: 1, name: "P", statuses: [], members: [], crmClientId: null };
    const svc = new ProjectsQueryService(makeDb(project).db, makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).resolves.toEqual({ ...project, crmClient: null });
  });

  it("throws ProjectsNotFoundException (404) when the project does not exist in the org, so a cross-tenant probe gets 404 not 403", async () => {
    mockResolveProjectAccess.mockRejectedValue(new NotFoundException("Project not found"));
    const svc = new ProjectsQueryService(makeDb(null).db, makeAudit(), makeAccess());
    await expect(svc.getProject(makeUser(), 1)).rejects.toThrow(ProjectsNotFoundException);
  });

  it("calls resolveProjectAccess exactly once per getProject call so the access decision has a single authoritative source", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "OWNER" });
    const project = { id: 5, name: "X", statuses: [], members: [], crmClientId: null };
    const svc = new ProjectsQueryService(makeDb(project).db, makeAudit(), makeAccess());
    await svc.getProject(makeUser(), 5);
    expect(mockResolveProjectAccess).toHaveBeenCalledTimes(1);
  });

  it("matches business_parties on party_id, the column that exists, so the project detail read cannot raise 42703 column bp.id does not exist", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeDb({ id: 6, name: "P", statuses: [], members: [], crmClientId: 42 }, []);
    const svc = new ProjectsQueryService(db.db, makeAudit(), makeAccess());

    await svc.getProject(makeUser(), 6);

    const joined = columnNamesIn(db.innerJoin.mock.calls[0]?.[1]);
    expect(joined).toContain("party_id");
    expect(joined).not.toContain("id");
  });

  it("carries organization_id across the party join so a client in another tenant cannot be reached", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeDb({ id: 6, name: "P", statuses: [], members: [], crmClientId: 42 }, []);
    const svc = new ProjectsQueryService(db.db, makeAudit(), makeAccess());

    await svc.getProject(makeUser("org-9"), 6);

    expect(columnNamesIn(db.innerJoin.mock.calls[0]?.[1])).toContain("organization_id");
    expect(columnNamesIn(db.where.mock.calls[0]?.[0])).toContain("organization_id");
  });

  it("returns the linked crm client when the project carries a crm_client_id", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const project = { id: 6, name: "P", statuses: [], members: [], crmClientId: 42 };
    const db = makeDb(project, [{ id: 42, name: "Acme" }]);
    const svc = new ProjectsQueryService(db.db, makeAudit(), makeAccess());

    await expect(svc.getProject(makeUser(), 6)).resolves.toEqual({
      ...project,
      crmClient: { id: 42, name: "Acme" },
    });
  });

  it("issues no client lookup at all when the project has no crm_client_id", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeDb({ id: 6, name: "P", statuses: [], members: [], crmClientId: null });
    const svc = new ProjectsQueryService(db.db, makeAudit(), makeAccess());

    await svc.getProject(makeUser(), 6);

    expect(db.select).not.toHaveBeenCalled();
  });
});

const NOW = new Date("2026-09-15T10:00:00.000Z");

describe("projectDetailSchema accepts the shape getProject returns", () => {
  const baseProject = {
    id: 1,
    orgId: "org-1",
    name: "P",
    description: null,
    key: "PRJ-001",
    clientMembershipId: null,
    managerMembershipId: null,
    startDate: null,
    endDate: null,
    status: "ACTIVE" as const,
    priority: null,
    dealId: null,
    managedProductId: null,
    budget: null,
    budgetMinor: null,
    budgetCurrency: null,
    settings: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    statuses: [],
    members: [],
  };

  it("accepts getProject output when crmClient is null so every project detail page parses correctly", () => {
    expect(() => projectDetailSchema.parse({ ...baseProject, crmClient: null })).not.toThrow();
  });

  it("accepts getProject output when crmClient carries id and name so linked-client projects parse correctly", () => {
    expect(() =>
      projectDetailSchema.parse({ ...baseProject, crmClient: { id: 42, name: "Acme Ltd" } })
    ).not.toThrow();
  });

  it("preserves crmClient in the parsed value so the FE can render the linked client without a second request", () => {
    const parsed = projectDetailSchema.parse({ ...baseProject, crmClient: { id: 7, name: "Corp" } });
    expect(parsed.crmClient).toEqual({ id: 7, name: "Corp" });
  });
});
