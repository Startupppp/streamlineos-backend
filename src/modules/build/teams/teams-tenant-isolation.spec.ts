import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { TeamsService } from "./teams.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("TeamsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;

  function makeSelectDb(firstCallRows: unknown[], subsequentRows: unknown[] = []) {
    const limit = jest.fn()
      .mockResolvedValueOnce(firstCallRows)
      .mockResolvedValue(subsequentRows);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin2 = jest.fn().mockReturnValue({ where });
    const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2, where });
    const from = jest.fn().mockReturnValue({ where, innerJoin: innerJoin1 });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("throws NotFoundException for getTeam on a different org (cross-tenant isolation)", async () => {
    const { db } = makeSelectDb([]);
    const svc = new TeamsService(db, audit);
    await expect(svc.getTeam(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns team for the owning org (same-tenant control)", async () => {
    const team = { id: 10, orgId: OWNER_ORG, name: "Eng" };
    const { db } = makeSelectDb([team], []);
    const svc = new TeamsService(db, audit);
    const result = await svc.getTeam(OWNER_ORG, 10);
    expect(result).toMatchObject({ id: 10 });
  });
});

describe("TeamsService.listTeams — memberCount subquery orgId scope", () => {
  it("memberCount correlated subquery includes orgId so team-member counts are tenant-scoped (failing before fix)", async () => {
    let capturedProjection: Record<string, unknown> | undefined;

    const builder = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const db = {
      select: jest.fn().mockImplementation((projection: Record<string, unknown>) => {
        capturedProjection = projection;
        return builder;
      }),
    } as unknown as Db;

    const svc = new TeamsService(db, {} as AuditService);
    await svc.listTeams("org-1", { pageSize: 20 }, null);

    expect(capturedProjection).toBeDefined();
    const memberCountExpr = capturedProjection?.memberCount;
    expect(memberCountExpr).toBeDefined();

    const rendered = render(memberCountExpr);
    expect(rendered).toContain("org_id");
  });
});
