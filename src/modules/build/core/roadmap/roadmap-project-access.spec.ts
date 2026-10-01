import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { AccessService } from "../../../access/access.service";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
} from "../project-crud/__tests__/project-access-doubles";
import { roadmapActor } from "./__tests__/roadmap-access-double";
import { createRoadmapSchema, updateRoadmapSchema } from "../dto/projects.schemas";
import { ProjectsRoadmapService } from "./projects-roadmap.service";

const ORG = "org-1";
const PROJECT_ID = 7;
const EPIC_ID = 70;
const ITEM_ID = 5;

const itemRow = {
  id: ITEM_ID,
  orgId: ORG,
  title: "Faster search",
  projectId: PROJECT_ID,
  epicTicketId: null,
  ownerMembershipId: null,
  votes: 0,
  reach: null,
  impact: null,
  confidence: null,
  effort: null,
  version: 1,
};

type EpicRow = { reachable: boolean } | null;

function makeDb(project: ProjectAccessRow | null, epic: EpicRow = null) {
  const projectRows = project === null ? [] : [project];
  const epicRows = epic === null ? [] : [{ projectId: PROJECT_ID, projectState: "ACTIVE", projectDeletedAt: null, reachable: epic.reachable, inScope: true }];
  const deliveryWhere: SQL[] = [];
  const rows: object[] = [];
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: (condition: SQL) => {
      deliveryWhere.push(condition);
      return chain;
    },
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: object[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const select = jest.fn((fields?: object) => {
    if (fields !== undefined && "memberRole" in fields)
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) };
    if (fields !== undefined && "inScope" in fields)
      return { from: () => ({ leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve(epicRows) }) }) }) };
    return chain;
  });
  const insert = jest.fn(() => ({ values: () => ({ returning: () => Promise.resolve([itemRow]) }) }));
  const update = jest.fn(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([itemRow]) }) }) }));
  return {
    select,
    insert,
    update,
    deliveryWhere,
    query: {
      roadmapItems: {
        findFirst: jest.fn().mockResolvedValue(itemRow),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
  };
}

async function build(project: ProjectAccessRow | null, epic: EpicRow = null) {
  const db = makeDb(project, epic);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsRoadmapService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { db, svc: moduleRef.get(ProjectsRoadmapService) };
}

const actor = roadmapActor(ORG);
const linkProject = createRoadmapSchema.parse({ title: "Faster search", projectId: PROJECT_ID });
const linkEpic = createRoadmapSchema.parse({ title: "Faster search", epicTicketId: EPIC_ID });
const relink = updateRoadmapSchema.parse({ version: 1, projectId: PROJECT_ID });

describe("roadmap links and signals are decided by the project-access rule", () => {
  it("POST /build/roadmap answers 403 when linking a same-org project the caller is not on", async () => {
    const { db, svc } = await build(projectAccessRow());
    await expect(svc.createRoadmap(actor, linkProject)).rejects.toThrow(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("POST /build/roadmap answers 404 when linking a project outside the caller's organisation", async () => {
    const { db, svc } = await build(null);
    await expect(svc.createRoadmap(actor, linkProject)).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("POST /build/roadmap links a project the caller is a member of", async () => {
    const { db, svc } = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(svc.createRoadmap(actor, linkProject)).resolves.toMatchObject({ id: ITEM_ID });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("POST /build/roadmap answers 403 when linking an epic on a project the caller does not reach", async () => {
    const { db, svc } = await build(null, { reachable: false });
    await expect(svc.createRoadmap(actor, linkEpic)).rejects.toThrow(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("POST /build/roadmap answers 404 for an epic that does not exist in the caller's organisation", async () => {
    const { db, svc } = await build(null, null);
    await expect(svc.createRoadmap(actor, linkEpic)).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("POST /build/roadmap links an epic the caller can read", async () => {
    const { db, svc } = await build(null, { reachable: true });
    await expect(svc.createRoadmap(actor, linkEpic)).resolves.toMatchObject({ id: ITEM_ID });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("PATCH /build/roadmap/:itemId answers 403 when relinking to a same-org project the caller is not on", async () => {
    const { db, svc } = await build(projectAccessRow());
    await expect(svc.updateRoadmap(actor, ITEM_ID, relink)).rejects.toThrow(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH /build/roadmap/:itemId answers 404 when relinking to a project outside the caller's organisation", async () => {
    const { db, svc } = await build(null);
    await expect(svc.updateRoadmap(actor, ITEM_ID, relink)).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH /build/roadmap/:itemId relinks to a project the caller is a member of", async () => {
    const { db, svc } = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(svc.updateRoadmap(actor, ITEM_ID, relink)).resolves.toMatchObject({ id: ITEM_ID });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("GET /build/roadmap conceals a projectId filter naming a same-org project the caller does not reach as 404", async () => {
    const { db, svc } = await build(projectAccessRow());
    await expect(svc.listRoadmapWithPrioritization(actor, { limit: 20, projectId: PROJECT_ID })).rejects.toThrow(NotFoundException);
    expect(db.query.roadmapItems.findMany).not.toHaveBeenCalled();
  });

  it("GET /build/roadmap answers 404 for a projectId filter outside the caller's organisation", async () => {
    const { db, svc } = await build(null);
    await expect(svc.listRoadmapWithPrioritization(actor, { limit: 20, projectId: PROJECT_ID })).rejects.toThrow(NotFoundException);
    expect(db.query.roadmapItems.findMany).not.toHaveBeenCalled();
  });

  it("GET /build/roadmap filters by a project the caller is a member of", async () => {
    const { db, svc } = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(svc.listRoadmapWithPrioritization(actor, { limit: 20, projectId: PROJECT_ID })).resolves.toMatchObject({ data: [] });
    expect(db.query.roadmapItems.findMany).toHaveBeenCalledTimes(1);
  });

  it("GET /build/roadmap/:itemId/signals counts delivery only over tickets the caller can see", async () => {
    const { db, svc } = await build(projectAccessRow());
    await svc.getRoadmapSignals(actor, ITEM_ID);
    const dialect = new PgDialect();
    const rendered = db.deliveryWhere.map((condition) => dialect.sqlToQuery(condition).sql).join("\n");
    expect(rendered).toContain('"build"."tickets"."project_id" = $');
    expect(rendered).toContain('"build"."tickets"."project_id" IN (SELECT "build"."projects"."id"');
    expect(rendered).toContain('"project_members"');
  });
});
