import { NotFoundException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ClientPortalService } from "./client-portal.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();
function renderSql(pred: unknown): string {
  if (!is(pred, SQL)) return "";
  return dialect.sqlToQuery(pred).sql;
}

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

const mockAudit = { log: jest.fn() } as unknown as AuditService;

const MINIMAL_PROJECT = {
  id: 10,
  name: "Preview",
  key: "PRV",
  status: "active",
  startDate: null,
  targetEndDate: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ClientPortalService.getPortalPreview — all client_visible content shown regardless of grant state", () => {
  function makePreviewDb(capturedPredicates: Array<{ idx: number; pred: unknown }>) {
    let selectCount = 0;
    const chain = (idx: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ idx, pred });
        return {
          limit: jest.fn().mockResolvedValue(idx === 1 ? [MINIMAL_PROJECT] : []),
        };
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: unknown) => {
          capturedPredicates.push({ idx, pred });
          return { limit: jest.fn().mockResolvedValue([]) };
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedPredicates.push({ idx, pred });
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(MINIMAL_PROJECT) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const ci = selectCount;
        return { from: jest.fn().mockReturnValue(chain(ci)) };
      }),
    } as unknown as Db;
  }

  it("milestones predicate contains client_visible so only portal-flagged milestones are shown in preview", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const milestoneEntry = predicates.find((e) => e.idx === 2);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("client_visible");
  });

  it("tasks predicate contains client_visible so only portal-flagged tickets are shown in preview", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const taskEntry = predicates.find((e) => e.idx === 3);
    expect(taskEntry).toBeDefined();
    expect(renderSql(taskEntry!.pred)).toContain("client_visible");
  });

  it("project predicate contains deleted_at so soft-deleted projects are excluded from preview", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const projectEntry = predicates.find((e) => e.idx === 1);
    expect(projectEntry).toBeDefined();
    expect(renderSql(projectEntry!.pred)).toContain("deleted_at");
  });

  it("throws NotFoundException when project does not exist in the caller's org", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(MINIMAL_PROJECT) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getPortalPreview(makeU("org-1"), 999)).rejects.toThrow(NotFoundException);
  });

  it("NEGATIVE — preview does not look up a grant so it does not fall closed when no grant exists", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.getPortalPreview(makeU("org-1"), 10);
    const allPredicateSql = predicates.map((e) => renderSql(e.pred)).join(" ");
    expect(allPredicateSql).not.toContain("project_client_grants");
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("milestones");
    expect(result).toHaveProperty("tasks");
  });
});
