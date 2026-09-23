import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ClientPortalService } from "src/modules/build/client-portal/client-portal.service";
import type { AccessService } from "src/modules/access/access.service";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import { humanSessionPrincipal } from "src/common/auth/principal";
import type { Db } from "src/db/drizzle.module";

const dialect = new PgDialect();
const BACKEND_ROOT = resolve(__dirname, "..", "..");

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

function makeSelectDb(
  findResult: Record<string, unknown> | undefined,
  selectRows: unknown[] = [],
) {
  const limit = jest.fn().mockResolvedValue(selectRows);
  const where = jest.fn().mockImplementation((cond: unknown) => {
    const p = Promise.resolve(selectRows) as Promise<unknown[]> & {
      limit: jest.Mock;
    };
    p.limit = limit;
    return p;
  });
  const from = jest.fn().mockReturnValue({ where });
  const findFirst = jest.fn().mockResolvedValue(findResult);
  const db = {
    query: { projects: { findFirst } },
    select: jest.fn().mockReturnValue({ from }),
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: 1,
                crNumber: 1,
                title: "t",
                description: null,
                impact: null,
                status: "submitted",
                estimateMinutes: null,
                budgetImpactCents: null,
                timelineImpactDays: null,
                decisionComment: null,
                createdAt: new Date(),
              },
            ]),
          }),
        }),
      }),
    ),
  } as unknown as Db;
  return { db, findFirst, where, limit };
}

const audit = { log: jest.fn() } as never;

const accessStub = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

function makeCtx(orgId: string, userId: string): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(CONTRACTOR_MEMBERSHIP, false),
  };
}

function makeService(db: Db) {
  return new ClientPortalService(db, accessStub, audit);
}

const CALLER_ORG = "org-caller";
const CALLER_USER = "user-caller";
const CONTRACTOR_MEMBERSHIP = 42;
const FOREIGN_PROJECT_ID = 8888;
const OWN_PROJECT_ID = 1;

describe("BSN-04-040 — portal identity cannot reach internal Build sidebar routes", () => {
  it("portal controller requires build:portal:view, not the internal build:view", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.controller.ts"),
      "utf8",
    );
    expect(src).toContain(`"build:portal:view"`);
    expect(src).not.toMatch(/RequirePermission\("build:view"\)/);
  });

  it("scope-directory controller declares build:view, which the portal permission key does not cover", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/scope-directory/scope-directory.controller.ts"),
      "utf8",
    );
    expect(src).toContain(`"build:view"`);
    expect(src).not.toContain(`"build:portal:view"`);
  });

  it("portfolios controller declares build:portfolios:view, disjoint from the portal key", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/portfolios/portfolios.controller.ts"),
      "utf8",
    );
    expect(src).toContain(`"build:portfolios:view"`);
    expect(src).not.toContain(`"build:portal:view"`);
  });

  it("managed-products controller declares build:managed-products:view, disjoint from portal key", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/managed-products/managed-products.controller.ts"),
      "utf8",
    );
    expect(src).toContain(`"build:managed-products:view"`);
    expect(src).not.toContain(`"build:portal:view"`);
  });

  it("teams controller declares build:teams:view, disjoint from the portal key", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/teams/teams.controller.ts"),
      "utf8",
    );
    expect(src).toMatch(/build:teams:view|build:view/);
    expect(src).not.toContain(`"build:portal:view"`);
  });
});

describe("BSN-04-041 — portal routes cannot read internal sidebar or agent data", () => {
  it("listPortalProjects SELECT projection does not expose workspace, team, budget or agent columns", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.service.ts"),
      "utf8",
    );
    const listFn = src.slice(
      src.indexOf("async listPortalProjects"),
      src.indexOf("async getProjectOverview"),
    );
    const selectBlock = listFn.slice(listFn.indexOf(".select({"), listFn.indexOf("})"));
    expect(selectBlock).not.toContain("pmWorkspace");
    expect(selectBlock).not.toContain("budget");
    expect(selectBlock).not.toContain("team");
    expect(selectBlock).not.toContain("agentPulse");
    expect(selectBlock).not.toContain("clientMembershipId");
    expect(selectBlock).not.toContain("membershipId:");
  });

  it("portal project list exposes only the six safe columns declared in the response schema", () => {
    const src = readFileSync(
      join(
        BACKEND_ROOT,
        "src/modules/build/client-portal/dto/client-portal-response.schemas.ts",
      ),
      "utf8",
    );
    const schema = src.slice(
      src.indexOf("portalProjectItemSchema"),
      src.indexOf("portalMilestoneSchema"),
    );
    expect(schema).toContain("id");
    expect(schema).toContain("name");
    expect(schema).toContain("key");
    expect(schema).toContain("status");
    expect(schema).toContain("startDate");
    expect(schema).toContain("targetEndDate");
    expect(schema).not.toContain("budget");
    expect(schema).not.toContain("workspace");
    expect(schema).not.toContain("team");
    expect(schema).not.toContain("agent");
  });

  it("portal overview applies clientVisible=true filter so internal-only items are excluded", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.service.ts"),
      "utf8",
    );
    const overviewFn = src.slice(
      src.indexOf("async getProjectOverview"),
      src.indexOf("async listPortalChangeRequests"),
    );
    const clientVisibleOccurrences = (overviewFn.match(/clientVisible.*true/g) ?? []).length;
    expect(clientVisibleOccurrences).toBeGreaterThanOrEqual(3);
  });

  it("portal overview schema does not contain internal financial or staffing columns", () => {
    const src = readFileSync(
      join(
        BACKEND_ROOT,
        "src/modules/build/client-portal/dto/client-portal-response.schemas.ts",
      ),
      "utf8",
    );
    const overview = src.slice(src.indexOf("portalProjectOverviewSchema"), src.indexOf("portalChangeRequestItemSchema"));
    expect(overview).not.toContain("budget");
    expect(overview).not.toContain("workspace");
    expect(overview).not.toContain("assigneeId");
    expect(overview).not.toContain("internalNote");
  });
});

describe("BSN-04-043 — contractor: only the explicitly shared project is visible", () => {
  it("assertClientProject raises NotFoundException when the project is not linked to this contractor", async () => {
    const { db } = makeSelectDb(undefined);
    await expect(
      makeService(db).listPortalChangeRequests(makeCtx(CALLER_ORG, CALLER_USER), FOREIGN_PROJECT_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it("assertClientProject does NOT raise when the project is the contractor's linked project (control)", async () => {
    const { db } = makeSelectDb({ id: OWN_PROJECT_ID }, [
      { id: "pm-1", projectId: OWN_PROJECT_ID },
    ]);
    await expect(
      makeService(db).listPortalChangeRequests(makeCtx(CALLER_ORG, CALLER_USER), OWN_PROJECT_ID),
    ).resolves.toBeDefined();
  });

  it("listPortalChangeRequests binds the contractor's own portal membership into the grant lookup", async () => {
    const { db, where } = makeSelectDb({ id: OWN_PROJECT_ID }, [
      { id: "pm-1", projectId: OWN_PROJECT_ID },
    ]);
    await makeService(db).listPortalChangeRequests(makeCtx(CALLER_ORG, CALLER_USER), OWN_PROJECT_ID);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain(CONTRACTOR_MEMBERSHIP);
    expect(renderParams(where.mock.calls[1]?.[0])).toContain("pm-1");
  });

  it("the refusal is NotFoundException, never ForbiddenException — cross-tenant probes get no existence signal", async () => {
    const { db } = makeSelectDb(undefined);
    const thrown = await makeService(db)
      .listPortalChangeRequests(makeCtx(CALLER_ORG, CALLER_USER), FOREIGN_PROJECT_ID)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it("listPortalProjects binds the caller's orgId in the WHERE clause", async () => {
    const { db, where } = makeSelectDb(undefined, []);
    await makeService(db).listPortalProjects(CALLER_ORG, CONTRACTOR_MEMBERSHIP);
    const params = renderParams(where.mock.calls[0]?.[0]);
    expect(params).toContain(CALLER_ORG);
  });

  it("listPortalProjects returns nothing when no project has this contractor as client", async () => {
    const { db } = makeSelectDb(undefined, []);
    const result = await makeService(db).listPortalProjects(CALLER_ORG, CONTRACTOR_MEMBERSHIP);
    expect(result).toEqual([]);
  });

  it("listPortalProjects binds the contractor membershipId in the WHERE clause (clientFilter)", async () => {
    const { db, where } = makeSelectDb(undefined, []);
    await makeService(db).listPortalProjects(CALLER_ORG, CONTRACTOR_MEMBERSHIP);
    const params = renderParams(where.mock.calls[0]?.[0]);
    expect(params).toContain(CONTRACTOR_MEMBERSHIP);
  });

  it("a contractor cannot see unrelated project data — WHERE binds both orgId and membershipId", async () => {
    const { db, where } = makeSelectDb(undefined, []);
    await makeService(db).listPortalProjects(CALLER_ORG, CONTRACTOR_MEMBERSHIP);
    const params = renderParams(where.mock.calls[0]?.[0]);
    expect(params).toContain(CALLER_ORG);
    expect(params).toContain(CONTRACTOR_MEMBERSHIP);
  });
});

describe("BSN-04-044 — portal user: only approved client-visible fields returned", () => {
  it("getProjectOverview raises NotFoundException when the project does not belong to the caller", async () => {
    const { db } = makeSelectDb(undefined, []);
    await expect(
      makeService(db).getProjectOverview(makeCtx(CALLER_ORG, CALLER_USER), FOREIGN_PROJECT_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it("the select columns for milestones in the overview do not include internal-only fields", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.service.ts"),
      "utf8",
    );
    const milestonesBlock = src.slice(
      src.indexOf("id: projectMilestones.id,"),
      src.indexOf("projectMilestones.deletedAt"),
    );
    expect(milestonesBlock).not.toContain("budget");
    expect(milestonesBlock).not.toContain("internalNote");
    expect(milestonesBlock).not.toContain("assigneeId");
  });

  it("tasks returned by the portal overview are filtered to clientVisible=true only", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.service.ts"),
      "utf8",
    );
    const tasksBlock = src.slice(
      src.indexOf("eq(tickets.clientVisible, true)"),
      src.indexOf("eq(ticketAttachments.clientVisible, true)"),
    );
    expect(tasksBlock).toContain("clientVisible");
  });

  it("comments returned by the portal overview expose only body, authorName and createdAt — no internal fields", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/client-portal/client-portal.service.ts"),
      "utf8",
    );
    const commentBlock = src.slice(
      src.indexOf("ticketComments.id,"),
      src.indexOf("from(ticketComments)"),
    );
    expect(commentBlock).not.toContain("internalNote");
    expect(commentBlock).not.toContain("userId:");
    expect(commentBlock).not.toContain("budget");
    expect(commentBlock).toContain("content");
    expect(commentBlock).toContain("createdAt");
  });
});
