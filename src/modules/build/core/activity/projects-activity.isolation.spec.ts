import { ProjectsActivityService } from "./projects-activity.service";
import type { NotificationsService } from "../../../notifications/notifications.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { Db } from "../../../../db/drizzle.module";

function makeInsertMock() {
  return jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });
}

function makeEmptySelectMock() {
  const limitMock = jest.fn().mockResolvedValue([]);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where: whereMock }),
  });
}

const mockNotifications = { create: jest.fn() } as unknown as NotificationsService;
const mockDispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;

beforeEach(() => {
  jest.resetAllMocks();
});

function makeProcessMentionMockDb({
  candidateIds = [] as string[],
  orgUsers = [] as Array<{
    id: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
  }>,
  membershipRows = [] as Array<{ id: number; userId: string }>,
} = {}) {
  const executeMock = jest.fn().mockResolvedValue(
    candidateIds.map((id) => ({ uid: id })),
  );

  let selectCallCount = 0;

  const limitMockUsers = jest.fn().mockResolvedValue(orgUsers);
  const whereMockUsers = jest.fn().mockReturnValue({ limit: limitMockUsers });
  const innerJoinMockUsers = jest
    .fn()
    .mockReturnValue({ where: whereMockUsers });
  const fromMock1 = jest
    .fn()
    .mockReturnValue({ innerJoin: innerJoinMockUsers });

  const fromMock2 = jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(membershipRows),
  });

  const selectMock = jest.fn().mockImplementation(() => {
    selectCallCount++;
    return { from: selectCallCount === 1 ? fromMock1 : fromMock2 };
  });

  const onConflictDoNothingMock = jest.fn().mockResolvedValue(undefined);
  const valuesMock = jest
    .fn()
    .mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });

  return {
    db: {
      execute: executeMock,
      select: selectMock,
      insert: insertMock,
    } as unknown as Db,
    executeMock,
    limitMockUsers,
    valuesMock,
  };
}

const BASE_MENTION_INPUT = {
  orgId: "org-mention",
  ticketId: 1,
  ticketNumber: 1,
  ticketTitle: "Ticket",
  projectId: null,
  commentId: 1,
  authorId: "author-99",
  authorName: "Author",
} as const;

describe("ProjectsActivityService — @mention matching contract (ticket 15)", () => {
  const noOpDispatch = {
    emit: jest.fn().mockReturnValue(Promise.resolve(undefined)),
  } as unknown as NotificationDispatchService;

  it("returns without any DB call when content has no @ symbol so non-mention content is zero-cost", async () => {
    const { db, executeMock } = makeProcessMentionMockDb();
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      noOpDispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "just a plain comment",
    });

    expect(executeMock).not.toHaveBeenCalled();
  });

  it("calls app.search_mention_user_ids exactly once so all tokens in one comment are batched to the SQL function in one round-trip", async () => {
    const { db, executeMock } = makeProcessMentionMockDb();
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      noOpDispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "please check @alice",
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the mention when the @-token exactly matches the user email prefix so @alice identifies alice@example.com", async () => {
    const orgUser = {
      id: "user-alice",
      name: null,
      firstName: "Alice",
      lastName: null,
      email: "alice@example.com",
    };
    const { db, valuesMock } = makeProcessMentionMockDb({
      candidateIds: ["user-alice"],
      orgUsers: [orgUser],
      membershipRows: [{ id: 10, userId: "user-alice" }],
    });
    const dispatch = {
      emit: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      dispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "please check @alice",
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ mentionedUserId: "user-alice" }),
      ]),
    );
  });

  it("resolves the mention when the @-token exactly matches the composed display name so '@Alice Smith' identifies the user with firstName Alice lastName Smith", async () => {
    const orgUser = {
      id: "user-alice",
      name: null,
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    };
    const { db, valuesMock } = makeProcessMentionMockDb({
      candidateIds: ["user-alice"],
      orgUsers: [orgUser],
      membershipRows: [{ id: 11, userId: "user-alice" }],
    });
    const dispatch = {
      emit: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      dispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "@Alice Smith",
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ mentionedUserId: "user-alice" }),
      ]),
    );
  });

  it("excludes the comment author from resolved mentions so authors are not self-notified", async () => {
    const orgUser = {
      id: "author-99",
      name: null,
      firstName: "Author",
      lastName: null,
      email: "author@example.com",
    };
    const { db, valuesMock } = makeProcessMentionMockDb({
      candidateIds: ["author-99"],
      orgUsers: [orgUser],
      membershipRows: [],
    });
    const dispatch = {
      emit: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      dispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "review @Author",
    });

    expect(valuesMock).not.toHaveBeenCalled();
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("limits the org candidate fetch to 20 rows so one mention cannot scan the full member list", async () => {
    const { db, limitMockUsers } = makeProcessMentionMockDb({
      candidateIds: ["user-1"],
    });
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      noOpDispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "@alice",
    });

    expect(limitMockUsers).toHaveBeenCalledWith(20);
  });

  it("does not resolve the mention when the @-token is a strict substring of the email prefix so @ali does not match alice@example.com", async () => {
    const orgUser = {
      id: "user-alice",
      name: null,
      firstName: "Alice",
      lastName: null,
      email: "alice@example.com",
    };
    const { db, valuesMock } = makeProcessMentionMockDb({
      candidateIds: ["user-alice"],
      orgUsers: [orgUser],
      membershipRows: [],
    });
    const dispatch = {
      emit: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    } as unknown as NotificationDispatchService;
    const svc = new ProjectsActivityService(
      db,
      {} as unknown as NotificationsService,
      dispatch,
    );

    await svc.processCommentMentions({
      ...BASE_MENTION_INPUT,
      content: "@ali",
    });

    expect(valuesMock).not.toHaveBeenCalled();
  });
});

describe("ProjectsActivityService — cross-tenant isolation", () => {
  it("logTicketActivity inserts with the caller-supplied orgId, never a global scope", async () => {
    let capturedValues: Record<string, unknown> | undefined;
    const insertFn = jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        capturedValues = v;
        return Promise.resolve(undefined);
      }),
    });
    const db = {
      insert: insertFn,
      select: makeEmptySelectMock(),
      query: {},
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, mockNotifications, mockDispatch);
    await svc.logTicketActivity("org-1", 42, "user-1", "created");

    expect(capturedValues?.["orgId"]).toBe("org-1");
    expect(capturedValues?.["ticketId"]).toBe(42);
  });

  it("logTicketActivity uses a different orgId per caller — cross-org isolation by predicate", async () => {
    const capturedOrgIds: string[] = [];
    const insertFn = jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        capturedOrgIds.push(String(v["orgId"] ?? ""));
        return Promise.resolve(undefined);
      }),
    });
    const db = {
      insert: insertFn,
      select: makeEmptySelectMock(),
      query: {},
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, mockNotifications, mockDispatch);
    await svc.logTicketActivity("org-a", 1, "user-1", "created");
    await svc.logTicketActivity("org-b", 2, "user-2", "status_changed");

    expect(capturedOrgIds).toEqual(["org-a", "org-b"]);
  });
});
