import { NotFoundException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { PortalClientService } from "./portal-client.service";
import { PortalProjectionService } from "../../build/client-portal/portal-projection.service";

const dialect = new PgDialect();

const makeAudit = () => ({ log: jest.fn() }) as unknown as AuditService;
const makeProjection = (db: Db) => new PortalProjectionService(db as never);

function renderSql(predicate: unknown): string {
  if (!is(predicate, SQL)) throw new Error("predicate is not a drizzle SQL instance");
  return dialect.sqlToQuery(predicate).sql;
}

describe("PortalClientService — expiresAt enforced at query level (Requirement D)", () => {
  it("loadActiveGrant WHERE clause contains expires_at so an expired grant is excluded by the database, not application code", async () => {
    let capturedPredicate: unknown;
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedPredicate = pred;
      return { limit: jest.fn().mockResolvedValue([]) };
    });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.getProjectOverview("org-1", "mem-1", 1)).rejects.toThrow(NotFoundException);

    expect(where).toHaveBeenCalledTimes(1);
    expect(renderSql(capturedPredicate)).toContain("expires_at");
  });

  it("listGrantedProjects WHERE clause contains expires_at so expired grants are excluded by the database, not application code", async () => {
    let capturedPredicate: unknown;
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedPredicate = pred;
      return {
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      };
    });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.listGrantedProjects("org-1", "mem-1");

    expect(where).toHaveBeenCalledTimes(1);
    expect(renderSql(capturedPredicate)).toContain("expires_at");
  });

  it("listGrantedProjects returns empty when no active non-expired grants exist for the membership (correct exclusion control)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    const result = await svc.listGrantedProjects("org-1", "mem-1");
    expect(result).toHaveLength(0);
  });

  it("listGrantedProjects returns projects when a non-expired active grant exists for the membership (same-tenant control)", async () => {
    const projectRow = { id: 7, name: "Proj", key: "P7", status: "active", startDate: null, targetEndDate: null };
    const projectWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([projectRow]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: projectWhere }) }),
    } as unknown as Db;
    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    const result = await svc.listGrantedProjects("org-1", "mem-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("id", 7);
  });

  it("loadActiveGrant throws NotFoundException when the membership has no matching active non-expired grant (expired grant excluded by DB)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
      }),
    } as unknown as Db;
    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.getProjectOverview("org-1", "mem-1", 5)).rejects.toThrow(NotFoundException);
  });
});
