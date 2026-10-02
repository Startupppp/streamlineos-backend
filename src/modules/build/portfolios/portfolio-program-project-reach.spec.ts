import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  MEMBER_STANDING,
  projectAccessRow,
  type ProjectAccessRow,
} from "../__tests__/project-access-doubles";
import { actorIn, portfoliosService, programsService } from "./__tests__/portfolio-spec-fixtures";

const ORG = "org-1";
const dialect = new PgDialect();

function render(where: SQL | undefined) {
  if (where === undefined) throw new Error("expected the linked-projects WHERE to be captured");
  return dialect.sqlToQuery(where);
}

function linkDb(project: ProjectAccessRow | null) {
  const containerChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => [{ id: 1, orgId: ORG, name: "Container" }]),
  };
  const projectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => (project === null ? [] : [project])),
  };
  const onConflictDoNothing = jest.fn(async () => undefined);
  const deleteWhere = jest.fn(async () => undefined);
  return {
    select: jest.fn((fields?: Record<string, unknown>) =>
      fields !== undefined && "manages" in fields ? projectChain : containerChain,
    ),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ onConflictDoNothing })) })),
    delete: jest.fn(() => ({ where: deleteWhere })),
    onConflictDoNothing,
    deleteWhere,
  };
}

function captureLinkedProjectsWhere() {
  const containerChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => [{ id: 1, orgId: ORG, name: "Container" }]),
  };
  const linkedWhereResult = {
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => []),
  };
  const linkedChain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn<typeof linkedWhereResult, [SQL]>(() => linkedWhereResult),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => []),
  };
  const programsChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => []),
  };
  const select = jest.fn((fields?: Record<string, unknown>) => {
    if (fields === undefined) return containerChain;
    if ("key" in fields) return linkedChain;
    return programsChain;
  });
  return { db: { select }, linkedWhere: () => linkedChain.where.mock.calls[0]?.[0] };
}

const managedProject = projectAccessRow({ manages: true });
const memberProject = projectAccessRow({ memberRole: "MEMBER" });

describe.each([
  ["portfolio", portfoliosService],
  ["program", programsService],
])("%s project links require manage on the linked project", (_kind, build) => {
  it("refuses to link a project the caller only belongs to with 403, writing nothing", async () => {
    const db = linkDb(memberProject);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.linkProject(actorIn(ORG), 1, { projectId: 5 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses to link a project outside the caller's org with 404, writing nothing", async () => {
    const db = linkDb(null);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.linkProject(actorIn(ORG), 1, { projectId: 99 })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("links a project the caller manages", async () => {
    const db = linkDb(managedProject);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.linkProject(actorIn(ORG), 1, { projectId: 5 })).resolves.toEqual({ success: true });
    expect(db.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it.each(["ARCHIVED", "COMPLETED"] as const)("links and unlinks a %s project the caller manages", async (state) => {
    const linkTarget = linkDb(projectAccessRow({ state, manages: true }));
    const linkSvc = await build(linkTarget, { log: jest.fn() }, MEMBER_STANDING);
    await expect(linkSvc.linkProject(actorIn(ORG), 1, { projectId: 5 })).resolves.toEqual({ success: true });
    expect(linkTarget.onConflictDoNothing).toHaveBeenCalledTimes(1);

    const unlinkTarget = linkDb(projectAccessRow({ state, manages: true }));
    const unlinkSvc = await build(unlinkTarget, { log: jest.fn() }, MEMBER_STANDING);
    await unlinkSvc.unlinkProject(actorIn(ORG), 1, 5);
    expect(unlinkTarget.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("refuses to link an archived project the caller only belongs to with 403, writing nothing", async () => {
    const db = linkDb(projectAccessRow({ state: "ARCHIVED", memberRole: "MEMBER" }));
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.linkProject(actorIn(ORG), 1, { projectId: 5 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses to unlink a project outside the caller's org with 404, deleting nothing", async () => {
    const db = linkDb(null);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.unlinkProject(actorIn(ORG), 1, 99)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("refuses to unlink a project the caller does not manage with 403, deleting nothing", async () => {
    const db = linkDb(memberProject);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await expect(svc.unlinkProject(actorIn(ORG), 1, 5)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("unlinks a project the caller manages", async () => {
    const db = linkDb(managedProject);
    const svc = await build(db, { log: jest.fn() }, MEMBER_STANDING);

    await svc.unlinkProject(actorIn(ORG), 1, 5);
    expect(db.deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe("portfolio and program detail list only projects the caller can reach", () => {
  it("binds the caller's project membership into the portfolio's linked-projects page for a member", async () => {
    const { db, linkedWhere } = captureLinkedProjectsWhere();
    const svc = await portfoliosService(db, { log: jest.fn() }, MEMBER_STANDING);

    await svc.getPortfolio(actorIn(ORG, "user-1", 7), 1, { projectsLimit: 20, programsLimit: 20 });

    const { sql: text, params } = render(linkedWhere());
    expect(text).toMatch(/project_members/);
    expect(params).toContain(7);
  });

  it("does not narrow the portfolio's linked-projects page for an org-wide manager", async () => {
    const { db, linkedWhere } = captureLinkedProjectsWhere();
    const svc = await portfoliosService(db);

    await svc.getPortfolio(actorIn(ORG, "user-1", 7), 1, { projectsLimit: 20, programsLimit: 20 });

    expect(render(linkedWhere()).sql).not.toMatch(/project_members/);
  });

  it("binds the caller's project membership into the program's linked-projects page for a member", async () => {
    const { db, linkedWhere } = captureLinkedProjectsWhere();
    const svc = await programsService(db, { log: jest.fn() }, MEMBER_STANDING);

    await svc.getProgram(actorIn(ORG, "user-1", 7), 1, { projectsLimit: 20 });

    const { sql: text, params } = render(linkedWhere());
    expect(text).toMatch(/project_members/);
    expect(params).toContain(7);
  });
});
