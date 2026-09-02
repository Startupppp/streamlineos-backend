import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { MfaPolicyService } from "../access/mfa-policy.service";
import { MfaService } from "./mfa.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));

const dialect = new PgDialect();

const HOME_ORG = "org-home";
const FOREIGN_ORG = "org-foreign";
const HOME_MEMBER = "user-home";
const FOREIGN_MEMBER = "user-foreign";

const MEMBERSHIPS = [
  { orgId: HOME_ORG, userId: HOME_MEMBER },
  { orgId: FOREIGN_ORG, userId: FOREIGN_MEMBER },
];

interface Harness {
  db: Db;
  updatedUserIds: string[];
  deletedBackupCodeCalls: number;
  invalidateUser: jest.Mock;
}

function makeHarness(): Harness {
  const updatedUserIds: string[] = [];
  let deletedBackupCodeCalls = 0;
  const invalidateUser = jest.fn();

  const membershipFindFirst = jest.fn(({ where }: { where: SQL }) => {
    const params = dialect.sqlToQuery(where).params;
    const [orgId, userId] = params;
    const row = MEMBERSHIPS.find(
      (m) => m.orgId === orgId && m.userId === userId,
    );
    return Promise.resolve(row ? { userId: row.userId } : undefined);
  });

  const db = {
    query: {
      organizationMembers: { findFirst: membershipFindFirst },
      users: { findFirst: jest.fn() },
    },
    transaction: (work: (tx: unknown) => Promise<unknown>) =>
      work({
        update: () => ({
          set: () => ({
            where: (predicate: SQL) => {
              const [userId] = dialect.sqlToQuery(predicate).params;
              if (typeof userId === "string") updatedUserIds.push(userId);
              return Promise.resolve([]);
            },
          }),
        }),
        delete: () => ({
          where: () => {
            deletedBackupCodeCalls += 1;
            return Promise.resolve([]);
          },
        }),
      }),
  };

  return {
    db: db as unknown as Db,
    updatedUserIds,
    get deletedBackupCodeCalls() {
      return deletedBackupCodeCalls;
    },
    invalidateUser,
  };
}

function makeService(harness: Harness): MfaService {
  const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
  const policy = {
    invalidateUser: harness.invalidateUser,
  } as unknown as MfaPolicyService;
  return new MfaService(harness.db, dispatch, policy);
}

describe("MfaService.reset — cross-tenant isolation", () => {
  it("resets a member of the caller's own organization (same-tenant control)", async () => {
    const harness = makeHarness();

    await expect(
      makeService(harness).reset(HOME_MEMBER, HOME_ORG),
    ).resolves.toEqual({ reset: true });
    expect(harness.updatedUserIds).toEqual([HOME_MEMBER]);
    expect(harness.deletedBackupCodeCalls).toBe(1);
    expect(harness.invalidateUser).toHaveBeenCalledWith(HOME_MEMBER);
  });

  it("refuses to reset a user who belongs to another organization", async () => {
    const harness = makeHarness();

    await expect(
      makeService(harness).reset(FOREIGN_MEMBER, HOME_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.updatedUserIds).toEqual([]);
    expect(harness.deletedBackupCodeCalls).toBe(0);
    expect(harness.invalidateUser).not.toHaveBeenCalled();
  });

  it("refuses to reset a user id that belongs to no organization", async () => {
    const harness = makeHarness();

    await expect(
      makeService(harness).reset("user-nowhere", HOME_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.updatedUserIds).toEqual([]);
  });

  it("scopes the membership lookup by organization and user together", async () => {
    const harness = makeHarness();
    await makeService(harness).reset(HOME_MEMBER, HOME_ORG).catch(() => undefined);

    const findFirst = harness.db.query.organizationMembers
      .findFirst as unknown as jest.Mock;
    const { sql, params } = dialect.sqlToQuery(
      findFirst.mock.calls[0][0].where as SQL,
    );
    expect(sql).toContain('"organization_members"."org_id"');
    expect(sql).toContain('"organization_members"."user_id"');
    expect(params).toEqual([HOME_ORG, HOME_MEMBER]);
  });
});
