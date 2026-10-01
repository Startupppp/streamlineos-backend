import { Test } from "@nestjs/testing";
import { UserProfileService } from "../users/user-profile.service";
import { SessionsService } from "./sessions.service";
import { CacheService } from "../../common/cache/cache.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { ReportingRelationshipService } from "../directory/reporting-relationship.service";
import { UserActivityService } from "../users/user-activity.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { auditLogs, userSessions } from "../../db/schema";

async function flushAfterCommit(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function buildService(liveSessions: { id: string }[]) {
  const inserted: Array<{ table: unknown; row: unknown }> = [];
  const updatedTables: unknown[] = [];
  const order: string[] = [];
  const mockDb: Record<string, unknown> = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ userId: "target" }),
      },
    },
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: unknown) => {
        inserted.push({ table, row });
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        });
      }),
    })),
    update: jest.fn((table: unknown) => {
      updatedTables.push(table);
      return {
        set: () => ({
          where: () => ({
            returning: () => {
              order.push("revoked-in-tx");
              return Promise.resolve(table === userSessions ? liveSessions : []);
            },
          }),
        }),
      };
    }),
  };
  mockDb["transaction"] = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockDb));
  const publishRevocations = jest.fn().mockImplementation(() => {
    order.push("tombstoned");
    return Promise.resolve();
  });
  const getFacts = jest.fn().mockResolvedValue(null);

  const ref = await Test.createTestingModule({
    providers: [
      UserProfileService,
      { provide: DRIZZLE, useValue: mockDb },
      {
        provide: CacheService,
        useValue: {
          invalidate: jest.fn().mockResolvedValue(undefined),
          invalidateNamespace: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: SessionsService, useValue: { publishRevocations } },
      { provide: EmploymentFactsService, useValue: { getFacts } },
      { provide: ReportingRelationshipService, useValue: {} },
      { provide: UserActivityService, useValue: { getUserActivity: jest.fn().mockResolvedValue([]) } },
    ],
  }).compile();

  return {
    svc: ref.get(UserProfileService),
    publishRevocations,
    getFacts,
    inserted,
    updatedTables,
    order,
  };
}

describe("administrative session revocation commits once through the access-mutation commit", () => {
  it("revokeAllSessions flips every live session on the transaction, audits it there, and tombstones only after commit", async () => {
    const { svc, publishRevocations, getFacts, inserted, updatedTables, order } =
      await buildService([{ id: "s1" }, { id: "s2" }]);

    await svc.revokeAllSessions("org-1", "target", "admin-1");
    await flushAfterCommit();

    expect(updatedTables).toContain(userSessions);
    expect(inserted.filter((entry) => entry.table === auditLogs)[0]?.row).toMatchObject({
      action: "user.sessions.revoked_all",
      userId: "admin-1",
      orgId: "org-1",
      targetId: "target",
    });
    expect(publishRevocations).toHaveBeenCalledWith(["s1", "s2"]);
    expect(order).toEqual(["revoked-in-tx", "tombstoned"]);
    expect(getFacts).not.toHaveBeenCalled();
  });

  it("revokeSession tombstones the single session it revoked", async () => {
    const { svc, publishRevocations, inserted } = await buildService([{ id: "sess-9" }]);

    await svc.revokeSession("org-1", "target", "sess-9", "admin-1");
    await flushAfterCommit();

    expect(publishRevocations).toHaveBeenCalledWith(["sess-9"]);
    expect(inserted.filter((entry) => entry.table === auditLogs)[0]?.row).toMatchObject({
      action: "user.session.revoked",
      metadata: { sessionId: "sess-9" },
    });
  });

  it("still audits but publishes no tombstone when nothing was live", async () => {
    const { svc, publishRevocations, inserted } = await buildService([]);

    await svc.revokeAllSessions("org-1", "target", "admin-1");
    await flushAfterCommit();

    expect(inserted.some((entry) => entry.table === auditLogs)).toBe(true);
    expect(publishRevocations).not.toHaveBeenCalled();
  });
});
