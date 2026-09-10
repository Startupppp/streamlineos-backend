import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { TasksService } from "./tasks.service";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const ORG = "org-1";
const ACTOR = "user-actor";
const OTHER = "user-other";
const dialect = new PgDialect();

const actor = (): CurrentUserContext =>
  ({
    orgId: ORG,
    userId: ACTOR,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  }) as CurrentUserContext;

function harness(scope: "all" | "own" | "none") {
  const wheres: SQL[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"])
    builder[method] = (arg?: unknown) => {
      if (method === "where" && arg) wheres.push(arg as SQL);
      return builder;
    };
  Object.assign(builder, { then: (resolve: (rows: unknown[]) => void) => resolve([]) });
  const db = { select: () => builder } as unknown as Db;
  const access = {
    resolveUserPermissions: async () => new Map([["crm:tasks:view", scope]]),
  } as never;
  return { service: new TasksService(db, {} as never, access), wheres };
}

describe("GET /tasks — ?assigneeId cannot widen below all", () => {
  it("binds both the requested assignee and the acting user at own scope", async () => {
    const { service, wheres } = harness("own");
    await service.list(actor(), { assigneeId: OTHER, limit: 10 } as never);

    const rendered = wheres.map((where) => dialect.sqlToQuery(where));
    expect(rendered.length).toBeGreaterThan(0);
    for (const { params } of rendered) {
      expect(params).toContain(OTHER);
      expect(params).toContain(ACTOR);
    }
  });

  it("binds only the requested assignee at all scope, because nothing narrows it", async () => {
    const { service, wheres } = harness("all");
    await service.list(actor(), { assigneeId: OTHER, limit: 10 } as never);

    const params = dialect.sqlToQuery(wheres[0] as SQL).params;
    expect(params).toContain(OTHER);
    expect(params).not.toContain(ACTOR);
  });

  it("issues no query at all when the caller holds none", async () => {
    const { service, wheres } = harness("none");
    const result = await service.list(actor(), { assigneeId: OTHER, limit: 10 } as never);

    expect(wheres).toHaveLength(0);
    expect(result.tasks).toEqual([]);
  });
});
