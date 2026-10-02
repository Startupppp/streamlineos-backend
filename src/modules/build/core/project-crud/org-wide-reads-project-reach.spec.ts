import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { orgTicketSearchQuery } from "./projects-search.service";
import { resolveTicketVisibility } from "./project-access";
import { ProjectsReleasesService } from "../releases/projects-releases.service";
import { ProjectsWorkQueryService } from "../work-query/projects-work-query.service";
import { MEMBER_STANDING, principalAccess } from "../../__tests__/project-access-doubles";

const dialect = new PgDialect();
const unconnected = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), { schema });

function actor(isOrgOwner = false): CurrentUserContext {
  return {
    orgId: "org-1",
    userId: "user-1",
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

function capturingDb() {
  const captured: SQL[] = [];
  const terminal = { orderBy: () => ({ limit: async () => [] }), groupBy: async () => [] };
  const chain = {
    leftJoin: (): object => chain,
    innerJoin: (): object => chain,
    where: (predicate: SQL) => {
      captured.push(predicate);
      return terminal;
    },
  };
  const db = { select: () => ({ from: () => chain }) } as unknown as Db;
  return { db, captured };
}

const sqlOf = (predicate: SQL | undefined) => {
  if (!predicate) throw new Error("expected a predicate");
  return dialect.sqlToQuery(predicate).sql;
};

describe("org-wide Build reads filter through the project-access reach rule", () => {
  it("ticket search narrows a member to reachable projects and their ticket scope instead of a private membership copy", async () => {
    const visible = await resolveTicketVisibility(principalAccess({ ...MEMBER_STANDING, "build:tickets:view": "own" }), actor());
    const { sql } = orgTicketSearchQuery(unconnected, "org-1", visible, "bug", 5).toSQL();
    expect(sql).toContain("project_members");
    expect(sql).toContain("project_team_assignments");
    expect(sql).toContain("reporter_id");
  });

  it("ticket search gives the org owner every project, matching the per-project decision", async () => {
    const visible = await resolveTicketVisibility(principalAccess(MEMBER_STANDING), actor(true));
    const { sql } = orgTicketSearchQuery(unconnected, "org-1", visible, "bug", 5).toSQL();
    expect(sql).not.toContain("project_members");
  });

  it("the org release list is limited to releases of reachable projects for a member", async () => {
    const { db, captured } = capturingDb();
    const service = new ProjectsReleasesService(
      db, principalAccess(MEMBER_STANDING) as unknown as AccessService, { log: jest.fn() } as unknown as AuditService,
    );
    await service.listOrgReleases(actor(), { limit: 20 });
    expect(sqlOf(captured[0])).toContain("project_members");
  });

  it("the org release list is unrestricted for the org owner", async () => {
    const { db, captured } = capturingDb();
    const service = new ProjectsReleasesService(
      db, principalAccess(MEMBER_STANDING) as unknown as AccessService, { log: jest.fn() } as unknown as AuditService,
    );
    await service.listOrgReleases(actor(true), { limit: 20 });
    expect(sqlOf(captured[0])).not.toContain("project_members");
  });

  it("work counts give the org owner the same owner bypass as the project list instead of requiring membership", async () => {
    const { db, captured } = capturingDb();
    const service = new ProjectsWorkQueryService(db, principalAccess(MEMBER_STANDING) as unknown as AccessService);
    await service.countTicketsByStatus(actor(true), { scope: "all" });
    expect(sqlOf(captured[0])).not.toContain("project_members");
  });

  it("work counts still narrow a plain member to reachable projects", async () => {
    const { db, captured } = capturingDb();
    const service = new ProjectsWorkQueryService(db, principalAccess(MEMBER_STANDING) as unknown as AccessService);
    await service.countTicketsByStatus(actor(), { scope: "all" });
    expect(sqlOf(captured[0])).toContain("project_members");
  });
});
