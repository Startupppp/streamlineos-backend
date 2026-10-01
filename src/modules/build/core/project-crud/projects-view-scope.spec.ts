import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsQueryService } from "./projects-query.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { DataScope } from "../../../access/access.types";

const dialect = new PgDialect();

function actor(): CurrentUserContext {
  return {
    orgId: "org-a",
    userId: "engineer",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 12, isOrgOwner: false },
  };
}

async function listAs(scopes: Record<string, DataScope>): Promise<{ called: boolean; sql: string }> {
  const captured: { where: unknown } = { where: undefined };
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "orderBy"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain["where"] = jest.fn((cond: unknown) => {
    captured.where = cond;
    return chain;
  });
  chain["limit"] = jest.fn(() => Promise.resolve([]));
  const select = jest.fn(() => chain);

  const module = await Test.createTestingModule({
    providers: [
      ProjectsQueryService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: AuditService, useValue: {} },
      {
        provide: AccessService,
        useValue: { scopeFor: async (_u: CurrentUserContext, key: string) => scopes[key] ?? "none" },
      },
    ],
  }).compile();

  await module.get(ProjectsQueryService).listProjects(actor(), { status: "ALL", limit: 20 });
  await module.close();

  const rendered = captured.where === undefined
    ? ""
    : dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
  return { called: select.mock.calls.length > 0, sql: rendered };
}

describe("GET /build admits build:view, so the project list must not resolve its scope on build:manage alone", () => {
  it("returns projects to a role holding build:view without build:manage, instead of a silently empty list", async () => {
    const { called } = await listAs({ "build:view": "all" });
    expect(called).toBe(true);
  });

  it("restricts a build:view holder to projects they can reach, because a template grant defaults to scope all", async () => {
    const { sql } = await listAs({ "build:view": "all" });
    expect(sql).toContain("project_members");
    expect(sql).toContain("manager_membership_id");
  });

  it("leaves a build:manage holder unrestricted, so an administrator still sees every project", async () => {
    const { sql } = await listAs({ "build:manage": "all" });
    expect(sql).not.toContain("project_members");
  });

  it("still denies a caller holding neither key, so the none-scope guarantee is intact", async () => {
    const { called } = await listAs({});
    expect(called).toBe(false);
  });
});
