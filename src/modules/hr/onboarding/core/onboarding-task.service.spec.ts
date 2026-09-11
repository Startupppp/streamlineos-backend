process.env.APP_URL ??= "http://localhost:1000";

import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../../common/tenant/tenant-context";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { OnboardingTaskService } from "./onboarding-task.service";
import { ScopedRead } from "../../../access/scoped-read";

const USER: CurrentUserContext = {
  userId: "actor-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function selectOne(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function makeService(
  db: Record<string, unknown>,
  permissionEntries: Array<[string, "all" | "team" | "own" | "none"]>,
) {
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map(permissionEntries)),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  };
  const email = {
    sendOnboardingCompleteEmployeeEmail: jest.fn().mockResolvedValue(undefined),
    sendOnboardingCompleteHrEmail: jest.fn().mockResolvedValue(undefined),
  };
  const automation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
  const hrAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
  const probation = { setupProbationForUser: jest.fn().mockResolvedValue(undefined) };
  return {
    access,
    automation,
    hrAutomation,
    probation,
    service: new OnboardingTaskService(
      db as never,
      access as never,
      email as never,
      automation as never,
      hrAutomation as never,
      probation as never,
    ),
  };
}

describe("OnboardingTaskService task ownership", () => {
  afterEach(() => jest.restoreAllMocks());

  it("limits an ordinary employee to their own NEW_HIRE tasks", () => {
    const { service } = makeService({}, []);
    const condition = (
      service as unknown as {
        completionScope(
          user: CurrentUserContext,
          access: {
            canView: boolean;
            canComplete: boolean;
            onboardingScope: ScopedRead;
            employeeManageScope: ScopedRead;
            canManageAssets: boolean;
          },
        ): SQL;
      }
    ).completionScope(USER, {
      canView: true,
      canComplete: true,
      onboardingScope: ScopedRead.of(USER.orgId, USER.userId, "none"),
      employeeManageScope: ScopedRead.of(USER.orgId, USER.userId, "none"),
      canManageAssets: false,
    });
    const compiled = new PgDialect().sqlToQuery(condition);

    expect(compiled.params).toEqual(["NEW_HIRE", USER.userId]);
    expect(compiled.params).not.toContain("HR");
    expect(compiled.params).not.toContain("MANAGER");
    expect(compiled.params).not.toContain("IT");
  });

  it("adds only the role branches backed by AccessService capabilities", () => {
    const { service } = makeService({}, []);
    const completionScope = (
      service as unknown as {
        completionScope: (
          user: CurrentUserContext,
          access: {
            canView: boolean;
            canComplete: boolean;
            onboardingScope: ScopedRead;
            employeeManageScope: ScopedRead;
            canManageAssets: boolean;
          },
        ) => SQL;
      }
    ).completionScope.bind(service);
    const condition = completionScope(USER, {
      canView: true,
      canComplete: true,
      onboardingScope: ScopedRead.of(USER.orgId, USER.userId, "none"),
      employeeManageScope: ScopedRead.of(USER.orgId, USER.userId, "team"),
      canManageAssets: true,
    });
    const compiled = new PgDialect().sqlToQuery(condition);

    expect(compiled.params).toContain("MANAGER");
    expect(compiled.params).toContain("IT");
    expect(compiled.params).not.toContain("HR");
  });

  it("fails before loading a task when completion permission is absent", async () => {
    const db = { transaction: jest.fn() };
    const { service } = makeService(db, [["hr:onboarding:tasks:view", "all"]]);

    await expect(
      service.updateTask(USER, 7, { status: "COMPLETED" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("uses a scoped compare-and-set update and dispatches only after commit", async () => {
    const task = {
      id: 7,
      userId: "employee-1",
      ownerRole: "HR",
      status: "PENDING",
    };
    const returning = jest.fn().mockResolvedValue([{ id: 7 }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue(selectOne([task])),
      update: jest.fn().mockReturnValue({ set }),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const { service } = makeService(db, [
      ["hr:onboarding:tasks:complete", "all"],
      ["hr:onboarding:manage", "all"],
    ]);
    const dispatch = jest
      .spyOn(
        service as unknown as {
          dispatchOnboardingComplete: (
            orgId: string,
            employeeUserId: string,
          ) => Promise<void>;
        },
        "dispatchOnboardingComplete",
      )
      .mockResolvedValue(undefined);
    const afterCommit: AfterCommitHook[] = [];
    const context = {
      orgId: USER.orgId,
      audience: "INTERNAL",
      tx: tx as never,
      afterCommit,
    } as TenantContext;

    await expect(
      runWithTenantContext(context, () =>
        service.updateTask(USER, 7, { status: "COMPLETED" }),
      ),
    ).resolves.toEqual({ success: true });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "COMPLETED",
        completedBy: USER.userId,
        rowVersion: expect.anything(),
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);

    await afterCommit[0]?.();

    expect(dispatch).toHaveBeenCalledWith(USER.orgId, task.userId);
  });

  it("returns a clear conflict when another request changes the task", async () => {
    const task = {
      id: 7,
      userId: "employee-1",
      ownerRole: "HR",
      status: "PENDING",
    };
    const tx = {
      select: jest.fn().mockReturnValue(selectOne([task])),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const { service } = makeService(db, [
      ["hr:onboarding:tasks:complete", "all"],
      ["hr:onboarding:manage", "all"],
    ]);

    await expect(
      service.updateTask(USER, 7, { status: "COMPLETED" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
