import { withSavepoint } from "../../../data-quality/savepoint";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";
import { ProjectsActivityService } from "./projects-activity.service";
import type { Db } from "../../../../db/drizzle.module";
import type { NotificationsService } from "../../../notifications/notifications.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";

describe("withSavepoint in projects-activity — savepoint isolates the mention insert (ticket 38)", () => {
  it("processCommentMentions: a failing mention insert propagates out of withSavepoint and the outer transaction remains callable", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let transactionCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        transactionCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    await runWithTenantContext(
      { orgId: "org-activity-1", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        let caughtError: unknown;
        try {
          await withSavepoint(() =>
            Promise.reject(new Error("insert ticketCommentMentions failed")),
          );
        } catch (error: unknown) {
          caughtError = error;
        }
        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toBe("insert ticketCommentMentions failed");

        let outerWorkCompleted = false;
        await withSavepoint(async () => {
          outerWorkCompleted = true;
        });
        expect(outerWorkCompleted).toBe(true);
        expect(transactionCallCount).toBe(2);
      },
    );
  });

  it("processCommentMentions: the catch-swallow pattern leaves the main request work able to return its result — modelling the withSavepoint fix at line 428", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const mainResult = { ticketId: 42, commentId: 7 };

    const result = await runWithTenantContext(
      { orgId: "org-activity-2", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        await withSavepoint(() =>
          Promise.reject(new Error("mention insert failed")),
        ).catch(() => undefined);
        return mainResult;
      },
    );

    expect(result).toEqual(mainResult);
    expect(outerTransaction).toHaveBeenCalledTimes(1);
  });
});

function makeProcessMentionDb({
  candidateIds = [] as string[],
  orgUsers = [] as Array<{ id: string; name: string | null; firstName: string | null; lastName: string | null; email: string }>,
  membershipRows = [] as Array<{ id: number; userId: string }>,
} = {}) {
  const executeMock = jest.fn().mockResolvedValue(candidateIds.map((id) => ({ uid: id })));
  let selectCallCount = 0;

  const limitMockUsers = jest.fn().mockResolvedValue(orgUsers);
  const whereMockUsers = jest.fn().mockReturnValue({ limit: limitMockUsers });
  const innerJoinMockUsers = jest.fn().mockReturnValue({ where: whereMockUsers });
  const fromMock1 = jest.fn().mockReturnValue({ innerJoin: innerJoinMockUsers });
  const fromMock2 = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(membershipRows) });
  const selectMock = jest.fn().mockImplementation(() => {
    selectCallCount++;
    return { from: selectCallCount === 1 ? fromMock1 : fromMock2 };
  });
  const onConflictDoNothingMock = jest.fn().mockResolvedValue(undefined);
  const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
  return {
    db: { execute: executeMock, select: selectMock, insert: insertMock } as unknown as Db,
  };
}

const MENTION_INPUT = {
  orgId: "org-sp-act",
  ticketId: 1,
  ticketNumber: 1,
  ticketTitle: "Ticket",
  projectId: null,
  commentId: 1,
  authorId: "author-99",
  authorName: "Author",
} as const;

describe("processCommentMentions — withSavepoint wraps dispatch.emit (site 3, ticket 38)", () => {
  it("dispatch.emit is wrapped in a second withSavepoint — outerTx.transaction called twice when mentions resolve", async () => {
    const { db } = makeProcessMentionDb({
      candidateIds: ["user-alice"],
      orgUsers: [{ id: "user-alice", name: null, firstName: "Alice", lastName: null, email: "alice@example.com" }],
      membershipRows: [{ id: 10, userId: "user-alice" }],
    });

    const savepointTx = {} as unknown as TenantTx;
    let txCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        txCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(db, {} as unknown as NotificationsService, dispatch);

    await runWithTenantContext(
      { orgId: "org-sp-act", audience: "INTERNAL" as const, tx: outerTx },
      () => svc.processCommentMentions({ ...MENTION_INPUT, content: "@alice" }),
    );

    expect(txCallCount).toBe(2);
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
  });

  it("positive: dispatch.emit is called with the resolved user when @mention matches", async () => {
    const { db } = makeProcessMentionDb({
      candidateIds: ["user-alice"],
      orgUsers: [{ id: "user-alice", name: null, firstName: "Alice", lastName: null, email: "alice@example.com" }],
      membershipRows: [{ id: 10, userId: "user-alice" }],
    });

    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(db, {} as unknown as NotificationsService, dispatch);

    await svc.processCommentMentions({ ...MENTION_INPUT, content: "@alice" });

    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    const emitCall = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as { eventKey?: string; targetUserIds?: string[] };
    expect(emitCall?.eventKey).toBe("build.comment.mention");
    expect(emitCall?.targetUserIds).toContain("user-alice");
  });
});
