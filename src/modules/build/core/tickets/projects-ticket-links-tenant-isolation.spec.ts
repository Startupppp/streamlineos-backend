import type { Db } from "../../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { assertTicketReadAccess } from "./build-ticket-read-access";

jest.mock("./build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeCtx(orgId: string): CurrentUserContext {
  return { userId: "u1", orgId, isOrgOwner: false, sessionId: "s1" } as CurrentUserContext;
}

describe("ProjectsTicketLinksService — cross-tenant isolation", () => {
  const access = { scopeFor: jest.fn().mockResolvedValue("all"), resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) };

  beforeEach(() => {
    jest.mocked(assertTicketReadAccess).mockResolvedValue(undefined as never);
  });

  it("getGitLinks throws NotFoundException when project not found for attacker org (cross-tenant isolation — returns 404 not 403)", async () => {
    jest.mocked(assertTicketReadAccess).mockRejectedValueOnce(new NotFoundException("Ticket not found"));
    const db = {} as unknown as Db;
    const svc = new ProjectsTicketLinksService(db, access);

    await expect(svc.getGitLinks(makeCtx(ATTACKER_ORG), 1, 1)).rejects.toThrow(NotFoundException);
  });

  it("getGitLinks returns links for the owning org (control — same-tenant access works)", async () => {
    const fakeLink = { id: 1, provider: "github", refType: "pr", externalId: "123", title: "Fix", url: "https://github.com/x", author: null, status: null, createdAt: new Date() };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeLink]) }) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ProjectsTicketLinksService(db, access);

    const result = await svc.getGitLinks(makeCtx(OWNER_ORG), 1, 1);
    expect(result).toHaveLength(1);
  });
});

describe("ProjectsTicketRelationsService — cross-tenant isolation", () => {
  const access = { scopeFor: jest.fn().mockResolvedValue("all"), resolveUserPermissions: jest.fn() };

  beforeEach(() => {
    jest.mocked(assertTicketReadAccess).mockResolvedValue(undefined as never);
  });

  it("assertTicketReadAccess throws NotFoundException when ticket not found for attacker org (cross-tenant isolation — returns 404 not 403)", async () => {
    jest.mocked(assertTicketReadAccess).mockRejectedValueOnce(new NotFoundException("Ticket not found"));
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new ProjectsTicketRelationsService(db, access);

    const u = makeCtx(ATTACKER_ORG);
    await expect(svc.addRelation(u, 1, 999, { relatedTicketId: 1000, relationType: "blocks" })).rejects.toThrow(NotFoundException);
  });

  it("listRelations works within the owning org (control — same-tenant access works)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) },
        workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new ProjectsTicketRelationsService(db, access);

    const u = { ...makeCtx(OWNER_ORG), isOrgOwner: true } as CurrentUserContext;
    const result = await svc.listRelations(u, 1, 1);
    expect(result).toBeDefined();
  });
});
