import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsQueryService } from "./projects-query.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("ProjectsQueryService.getProject — team-access join must match list predicate", () => {
  it("team membership join includes orgId so getProject and listProjects use the same tenant-scoped predicate for the same relationship", async () => {
    const capturedJoinArgs: unknown[] = [];

    const teamLimit = jest.fn().mockResolvedValue([]);
    const teamWhere = jest.fn().mockReturnValue({ limit: teamLimit });
    const teamInnerJoin = jest.fn().mockImplementation((_table: unknown, condition: unknown) => {
      capturedJoinArgs.push(condition);
      return { where: teamWhere };
    });
    const teamFrom = jest.fn().mockReturnValue({ innerJoin: teamInnerJoin });

    const memberLimit = jest.fn().mockResolvedValue([]);
    const memberWhere = jest.fn().mockReturnValue({ limit: memberLimit });
    const memberFrom = jest.fn().mockReturnValue({ where: memberWhere });

    let selectCallCount = 0;
    const db = {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({
            id: 42,
            orgId: "org-owner",
            name: "Test",
            statuses: [],
            members: [],
          }),
        },
      },
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: memberFrom };
        return { from: teamFrom };
      }),
    } as unknown as Db;

    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
      scopeFor: jest.fn(),
    } as unknown as AccessService;

    const svc = new ProjectsQueryService(
      db,
      { log: jest.fn() } as unknown as AuditService,
      access,
      {} as never,
    );

    await expect(
      svc.getProject(
        {
          orgId: "org-owner",
          userId: "u-1",
          principal: humanSessionPrincipal(1, false),
        } as never,
        42,
      ),
    ).rejects.toThrow();

    expect(capturedJoinArgs.length).toBeGreaterThan(0);
    const joinSql = renderSql(capturedJoinArgs[0]);
    expect(joinSql).toMatch(/org_id/);
  });
});
