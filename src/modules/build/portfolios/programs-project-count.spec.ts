import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { ProgramsService } from "./programs.service";

const dialect = new PgDialect();

it("qualifies every project-count column across the program correlation", async () => {
  let projection: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn((value: Record<string, unknown>) => {
      projection = value;
      return builder;
    }),
  } as unknown as Db;
  const service = new ProgramsService(db, {} as AuditService);

  await service.listPrograms("org-1", {});

  const rendered = dialect.sqlToQuery(
    projection.projectCount as Parameters<PgDialect["sqlToQuery"]>[0],
  ).sql;
  expect(rendered).toContain('"program_project"."program_id" = "program"."id"');
  expect(rendered).toContain('"program_linked_project"."id" = "program_project"."project_id"');
  expect(rendered).not.toMatch(/\b"program_id"\s*=\s*"id"\b/);
});
