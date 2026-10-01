import { NotFoundException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ClientPortalService } from "./client-portal.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  type ProjectAccessRow,
} from "../core/project-crud/__tests__/project-access-doubles";

function projectGateSelect(rows: ProjectAccessRow[], rest: jest.Mock = jest.fn()): jest.Mock {
  return jest.fn((fields?: Record<string, unknown>) =>
    fields !== undefined && "manages" in fields
      ? { from: () => ({ where: () => ({ limit: async () => rows }) }) }
      : rest(fields),
  );
}


const memberScopeAccess = {
  scopeFor: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner ? "all" : (MEMBER_STANDING[key] ?? "none"),
  holds: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner || (MEMBER_STANDING[key] ?? "none") !== "none",
} as unknown as AccessService;

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

const mockAccess = memberScopeAccess;

const mockAudit = { log: jest.fn() } as unknown as AuditService;

const MINIMAL_PROJECT = {
  id: 10,
  name: "Preview",
  key: "PRV",
  status: "active",
  startDate: null,
  targetEndDate: null,
};

const ALL_CAPS_GRANT = {
  canViewMilestones: true,
  canViewTasks: true,
  canViewAttachments: true,
  canViewComments: true,
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ClientPortalService.getPortalPreview — grant is required; same projection seam as getProjectOverview", () => {
  function makePreviewDb(
    capturedPredicates: Array<{ idx: number; pred: unknown }>,
    grantRow: typeof ALL_CAPS_GRANT | null = ALL_CAPS_GRANT,
  ) {
    let selectCount = 0;
    const chain = (idx: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ idx, pred });
        return {
          limit: jest.fn().mockResolvedValue(idx === 1 ? [MINIMAL_PROJECT] : []),
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(idx === 2 && grantRow !== null ? [grantRow] : []),
          }),
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
      },
      select: projectGateSelect([projectAccessRow()], jest.fn().mockImplementation(() => {
        selectCount++;
        const ci = selectCount;
        return { from: jest.fn().mockReturnValue(chain(ci)) };
      })),
    } as unknown as Db;
  }

  it("milestones predicate contains client_visible so only portal-flagged milestones are shown in preview", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const milestoneEntry = predicates.find((e) => e.idx === 3);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("client_visible");
  });

  it("tasks predicate contains client_visible so only portal-flagged tickets are shown in preview", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const taskEntry = predicates.find((e) => e.idx === 4);
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
      },
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
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
      })),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getPortalPreview(makeU("org-1"), 999)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when no active grant exists so preview falls closed without a published portal", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates, null);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getPortalPreview(makeU("org-1"), 10)).rejects.toThrow(NotFoundException);
  });

  it("grant predicate includes project_client_grants so preview is gated on an active published portal", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const grantEntry = predicates.find((e) => e.idx === 2);
    expect(grantEntry).toBeDefined();
    expect(renderSql(grantEntry!.pred)).toContain("project_client_grants");
  });

  it("grant predicate contains expires_at so an expired grant does not constitute a published portal", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makePreviewDb(predicates);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getPortalPreview(makeU("org-1"), 10);
    const grantEntry = predicates.find((e) => e.idx === 2);
    expect(grantEntry).toBeDefined();
    expect(renderSql(grantEntry!.pred)).toContain("expires_at");
  });
});
