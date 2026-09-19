import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PmWorkspacesService } from "./pm-workspaces.service";

const ORG = "org-1";
const WS = "ws-1";
const MEMBERSHIP_ID = 42;

const audit = { log: jest.fn() } as never;

function makeDb(membershipRow: { pmWorkspaceMembershipId: string } | null) {
  const limitFn = jest.fn().mockResolvedValue(membershipRow !== null ? [membershipRow] : []);
  const whereFn = jest.fn().mockReturnValue({ limit: limitFn });
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  return {
    db: { select: jest.fn().mockReturnValue({ from: fromFn }) } as unknown as Db,
    whereFn,
  };
}

describe("PmWorkspacesService.assertMemberOfWorkspace", () => {
  it("resolves without throwing when the caller is a workspace member", async () => {
    const { db } = makeDb({ pmWorkspaceMembershipId: "pmwm-1" });
    const svc = new PmWorkspacesService(db, audit);
    await expect(svc.assertMemberOfWorkspace(ORG, WS, MEMBERSHIP_ID)).resolves.toBeUndefined();
  });

  it("throws ForbiddenException when the caller is not a workspace member", async () => {
    const { db } = makeDb(null);
    const svc = new PmWorkspacesService(db, audit);
    await expect(svc.assertMemberOfWorkspace(ORG, WS, MEMBERSHIP_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("skips the DB query and resolves when callerMembershipId is null (system caller)", async () => {
    const { db } = makeDb(null);
    const svc = new PmWorkspacesService(db, audit);
    await expect(svc.assertMemberOfWorkspace(ORG, WS, null)).resolves.toBeUndefined();
    const dbMock = db as unknown as { select: jest.Mock };
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("scopes the membership query by both orgId and pmWorkspaceId so a cross-tenant membership cannot pass", async () => {
    const { db, whereFn } = makeDb({ pmWorkspaceMembershipId: "pmwm-2" });
    const PgDialect = (await import("drizzle-orm/pg-core")).PgDialect;
    const dialect = new PgDialect();
    const svc = new PmWorkspacesService(db, audit);
    await svc.assertMemberOfWorkspace(ORG, WS, MEMBERSHIP_ID);
    const condition = whereFn.mock.calls[0]?.[0];
    const params = dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]).params;
    expect(params).toEqual(expect.arrayContaining([ORG, WS, MEMBERSHIP_ID]));
  });

  it("non-member in the same org is denied even when membership query returns empty", async () => {
    const { db } = makeDb(null);
    const svc = new PmWorkspacesService(db, audit);
    await expect(svc.assertMemberOfWorkspace(ORG, WS, 999)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
