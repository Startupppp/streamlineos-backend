import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { projectReleases, users } from "../../../../db/schema";
import { ProjectsReleasesService } from "./projects-releases.service";
import type { ListReleasesQuery, OrgListReleasesQuery } from "../dto/releases.schemas";
import {
  projectReleaseListItemSchema,
  projectReleaseRowSchema,
} from "../dto/build-core-response.schemas";
import { lifecycleAuditDouble } from "../../lifecycle/audit-double.spec-fixtures";

jest.mock("../project-crud/project-access", () => {
  const { sql } = jest.requireActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    assertProjectAccess: jest.fn(async () => undefined),
    resolveProjectReach: jest.fn(async () => ({ where: sql`true`, empty: false })),
  };
});

const ORG = "org-proj-1";
const PROJECT_ID = 10;

interface Join {
  kind: "leftJoin" | "innerJoin";
  table: unknown;
  on: unknown;
}

interface Capture {
  projection: Record<string, unknown> | undefined;
  joins: Join[];
}

function columnsOf(node: unknown, out: Column[]): Column[] {
  if (!(node instanceof SQL)) return out;
  for (const chunk of node.queryChunks as unknown[]) {
    if (chunk instanceof SQL) columnsOf(chunk, out);
    else if (chunk instanceof Column) out.push(chunk);
  }
  return out;
}

function makeDb(capture: Capture): Db {
  const chain: Record<string, unknown> = {
    leftJoin: (table: unknown, on: unknown) => {
      capture.joins.push({ kind: "leftJoin", table, on });
      return chain;
    },
    innerJoin: (table: unknown, on: unknown) => {
      capture.joins.push({ kind: "innerJoin", table, on });
      return chain;
    },
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
  };

  return {
    select: (projection: Record<string, unknown>) => {
      capture.projection = projection;
      return { from: () => chain };
    },
  } as unknown as Db;
}

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "ADMIN",
    isOrgOwner: false,
    sessionId: "session-proj-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(5, false),
  };
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

function makeService() {
  const capture: Capture = { projection: undefined, joins: [] };
  return { capture, svc: new ProjectsReleasesService(makeDb(capture), makeAccess(), lifecycleAuditDouble()) };
}

function createdByUserProjection(capture: Capture): Record<string, unknown> {
  const value = capture.projection?.["createdByUser"];
  if (value === undefined || value === null || typeof value !== "object") {
    throw new Error("listing did not project createdByUser");
  }
  return value as Record<string, unknown>;
}

const ORG_QUERY: OrgListReleasesQuery = { limit: 50 };
const PROJECT_QUERY: ListReleasesQuery = { limit: 25 };

describe("ProjectsReleasesService — createdByUser projection", () => {
  it("projects createdByUser on the org releases list, because the table renders a name and the column only holds an id", async () => {
    const { capture, svc } = makeService();
    await svc.listOrgReleases(makeU(), ORG_QUERY);

    expect(Object.keys(createdByUserProjection(capture)).sort()).toEqual([
      "email",
      "firstName",
      "lastName",
      "name",
    ]);
  });

  it("projects createdByUser on the per-project releases list, because the table renders a name and the column only holds an id", async () => {
    const { capture, svc } = makeService();
    await svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);

    expect(Object.keys(createdByUserProjection(capture)).sort()).toEqual([
      "email",
      "firstName",
      "lastName",
      "name",
    ]);
  });

  it("keeps createdBy alongside createdByUser on both lists, so the id stays available to filters that key on it", async () => {
    const org = makeService();
    await org.svc.listOrgReleases(makeU(), ORG_QUERY);
    expect(org.capture.projection?.["createdBy"]).toBe(projectReleases.createdBy);

    const project = makeService();
    await project.svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);
    expect(project.capture.projection?.["createdBy"]).toBe(projectReleases.createdBy);
  });

  it("projects exactly the four display columns and no authentication column from the global users table (BE-46)", async () => {
    const { capture, svc } = makeService();
    await svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);

    const projected = createdByUserProjection(capture);
    expect(projected["name"]).toBe(users.name);
    expect(projected["firstName"]).toBe(users.firstName);
    expect(projected["lastName"]).toBe(users.lastName);
    expect(projected["email"]).toBe(users.email);
  });

  it("joins users with leftJoin on both lists, so a release whose creator row is gone still appears in the list", async () => {
    const org = makeService();
    await org.svc.listOrgReleases(makeU(), ORG_QUERY);
    const orgJoin = org.capture.joins.find((join) => join.table === users);
    expect(orgJoin?.kind).toBe("leftJoin");

    const project = makeService();
    await project.svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);
    const projectJoin = project.capture.joins.find((join) => join.table === users);
    expect(projectJoin?.kind).toBe("leftJoin");
  });

  it("joins users on the createdBy column and not on any other id, so the resolved name is the creator's", async () => {
    const { capture, svc } = makeService();
    await svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);

    const join = capture.joins.find((entry) => entry.table === users);
    const joinColumns = columnsOf(join?.on, []);
    expect(joinColumns).toContain(users.id);
    expect(joinColumns).toContain(projectReleases.createdBy);
    expect(joinColumns).toHaveLength(2);
  });

  it("declares createdByUser on the list item schema only, because create and update return an unjoined row and a declared-but-unprojected key is a 500", () => {
    expect(Object.keys(projectReleaseListItemSchema.shape)).toContain("createdByUser");
    expect(Object.keys(projectReleaseRowSchema.shape)).not.toContain("createdByUser");
  });

  it("uses no innerJoin on either releases list, because an inner join to users would silently drop rows", async () => {
    const org = makeService();
    await org.svc.listOrgReleases(makeU(), ORG_QUERY);
    expect(org.capture.joins.filter((join) => join.kind === "innerJoin")).toEqual([]);

    const project = makeService();
    await project.svc.listReleases(makeU(), PROJECT_ID, PROJECT_QUERY);
    expect(project.capture.joins.filter((join) => join.kind === "innerJoin")).toEqual([]);
  });
});
