import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { ProjectsCustomStatesService } from "../custom-states/projects-custom-states.service";
import type { ProjectsLabelsService } from "../lib/projects-labels.service";
import type { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { ProjectsMembersService } from "./projects-members.service";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((condition: unknown) => {
      captured.where = condition;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }),
      },
    },
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
}

const actor = {
  orgId: "org-owner",
  userId: "owner-user",
  isOrgOwner: true,
} as CurrentUserContext;

function makeService(captured: Captured) {
  return new ProjectsMembersService(
    buildDb(captured),
    {} as ProjectsWebhooksDispatchService,
    {} as AccessService,
    {} as ProjectsCustomStatesService,
    {} as ProjectsLabelsService,
  );
}

function renderWhere(captured: Captured) {
  return dialect.sqlToQuery(
    captured.where as Parameters<PgDialect["sqlToQuery"]>[0],
  );
}

describe("ProjectsMembersService.listMembers search", () => {
  it("applies escaped server-side matching across member identity fields", async () => {
    const captured: Captured = { where: undefined };
    await makeService(captured).listMembers(actor, 42, {
      limit: 25,
      search: "Ada%_",
    });

    const { sql, params } = renderWhere(captured);
    expect((sql.match(/ilike/gi) ?? [])).toHaveLength(5);
    expect(
      params.filter(
        (value): value is string =>
          typeof value === "string" && value.startsWith("%"),
      ),
    ).toEqual([
      "%Ada\\%\\_%",
      "%Ada\\%\\_%",
      "%Ada\\%\\_%",
      "%Ada\\%\\_%",
      "%Ada\\%\\_%",
    ]);
    expect(sql).toContain('"project_members"."role"::text ilike');
  });

  it("keeps organization and project predicates when search is active", async () => {
    const captured: Captured = { where: undefined };
    await makeService(captured).listMembers(actor, 42, {
      limit: 25,
      search: "Ada",
    });

    const { sql, params } = renderWhere(captured);
    expect(sql).toContain('"project_members"."org_id"');
    expect(sql).toContain('"project_members"."project_id"');
    expect(sql).toContain('"projects"."deleted_at" is null');
    expect(params).toContain("org-owner");
    expect(params).toContain(42);
  });

  it("omits identity matching when no search term is supplied", async () => {
    const captured: Captured = { where: undefined };
    await makeService(captured).listMembers(actor, 42, { limit: 25 });

    expect(renderWhere(captured).sql.toLowerCase()).not.toContain("ilike");
  });
});
