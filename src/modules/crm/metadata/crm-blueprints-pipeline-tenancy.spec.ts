import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { CrmBlueprintsService } from "./crm-blueprints.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

const ATTACKER: CurrentUserContext = {
  userId: "user-attacker",
  orgId: "org-attacker",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-attacker",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

interface Captured {
  selectWheres: unknown[];
  inserted: unknown[];
}

function buildDb(captured: Captured, pipelineRows: unknown[]): Db {
  const selectBuilder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.selectWheres.push(cond);
      return selectBuilder;
    }),
    limit: jest.fn().mockResolvedValue(pipelineRows),
  };
  (selectBuilder.from as jest.Mock).mockReturnValue(selectBuilder);

  const insertBuilder: Record<string, unknown> = {
    values: jest.fn((row: unknown) => {
      captured.inserted.push(row);
      return insertBuilder;
    }),
    returning: jest.fn().mockResolvedValue([{ id: "bp-new" }]),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };

  return {
    select: jest.fn().mockReturnValue(selectBuilder),
    insert: jest.fn().mockReturnValue(insertBuilder),
  } as unknown as Db;
}

describe("CrmBlueprintsService.create — pipeline tenancy", () => {
  const input = { pipelineId: "pipeline-victim", name: "Blueprint", isActive: true };

  it("refuses a pipeline id that resolves in another org and writes nothing", async () => {
    const captured: Captured = { selectWheres: [], inserted: [] };
    const svc = new CrmBlueprintsService(buildDb(captured, []));

    await expect(svc.create(ATTACKER, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(captured.inserted).toHaveLength(0);
  });

  it("scopes the pipeline lookup to the caller org and excludes soft-deleted pipelines", async () => {
    const captured: Captured = { selectWheres: [], inserted: [] };
    const svc = new CrmBlueprintsService(buildDb(captured, []));

    await expect(svc.create(ATTACKER, input)).rejects.toBeInstanceOf(NotFoundException);

    const lookup = render(captured.selectWheres[0]);
    expect(lookup.sql).toContain('"crm_pipelines"."org_id"');
    expect(lookup.sql).toContain('"crm_pipelines"."deleted_at" is null');
    expect(lookup.params).toContain("org-attacker");
    expect(lookup.params).toContain("pipeline-victim");
  });

  it("inserts once the pipeline resolves inside the caller org", async () => {
    const captured: Captured = { selectWheres: [], inserted: [] };
    const svc = new CrmBlueprintsService(buildDb(captured, [{ id: "pipeline-victim" }]));

    await svc.create(ATTACKER, input);

    expect(captured.inserted[0]).toEqual(
      expect.objectContaining({ orgId: "org-attacker", pipelineId: "pipeline-victim" }),
    );
  });
});
