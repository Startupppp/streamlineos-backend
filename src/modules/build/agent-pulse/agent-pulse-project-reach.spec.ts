import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsTicketCommentsService } from "../core/tickets";
import {
  MANAGER_STANDING,
  MEMBER_STANDING,
  standingAccess,
  type StandingScopes,
} from "../core/project-crud/__tests__/project-access-doubles";
import { AgentPulseService } from "./agent-pulse.service";

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

const REACHABLE_SUBQUERY = 'IN (SELECT "build"."projects"."id" FROM "build"."projects" WHERE "build"."projects"."org_id" =';

async function build(scopes: StandingScopes) {
  const conditions: SQL[] = [];
  const capture = (condition: SQL) => {
    conditions.push(condition);
    return chain;
  };
  const chain = {
    from: () => chain,
    innerJoin: (_table: object, condition: SQL) => capture(condition),
    where: capture,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  const select = jest.fn(() => chain);
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentPulseService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: ProjectsTicketCommentsService, useValue: {} },
      { provide: AccessService, useValue: standingAccess(scopes) },
    ],
  }).compile();
  return { select, conditions, svc: moduleRef.get(AgentPulseService) };
}

function renderedPerQuery(conditions: SQL[]): string {
  const dialect = new PgDialect();
  return conditions.map((condition) => dialect.sqlToQuery(condition).sql).join("\n");
}

describe("GET /build/agent-pulse/top-signal only surfaces signals on projects the caller reaches", () => {
  it("binds all five signal queries to the caller's reachable projects", async () => {
    const built = await build(MEMBER_STANDING);
    await expect(built.svc.getTopSignal(actor)).resolves.toBeNull();
    expect(built.select).toHaveBeenCalledTimes(5);
    const rendered = renderedPerQuery(built.conditions);
    for (const column of [
      '"build"."project_approvals"."project_id"',
      '"build"."project_milestones"."project_id"',
      '"build"."project_risks"."project_id"',
      '"build"."tickets"."project_id"',
    ])
      expect(rendered).toContain(`${column} ${REACHABLE_SUBQUERY}`);
    expect(rendered).toContain('"project_members"');
  });

  it("returns no signal and never queries for a caller with no Build project standing", async () => {
    const built = await build({});
    await expect(built.svc.getTopSignal(actor)).resolves.toBeNull();
    expect(built.select).not.toHaveBeenCalled();
  });

  it("lets an organisation-wide build:manage holder see signals on every project (control)", async () => {
    const built = await build(MANAGER_STANDING);
    await built.svc.getTopSignal(actor);
    expect(built.select).toHaveBeenCalledTimes(5);
    expect(renderedPerQuery(built.conditions)).not.toContain('"project_members"');
  });
});
