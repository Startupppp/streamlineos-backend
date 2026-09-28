import { ProjectsActivityService } from "./projects-activity.service";
import type { NotificationsService } from "../../../notifications/notifications.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG_ID = "org-proj-writer";
const TICKET_ID = 42;
const USER_ID = "user-1";
const MEMBERSHIP_ID = 5;
const PROJECT_ID = 7;

const noOpNotifications = {} as unknown as NotificationsService;
const noOpDispatch = {} as unknown as NotificationDispatchService;

function makeSelectTwoCalls(
  firstRows: Record<string, unknown>[],
  secondRows: Record<string, unknown>[],
): jest.Mock {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    call++;
    const rows = call === 1 ? firstRows : secondRows;
    const limitMock = jest.fn().mockResolvedValue(rows);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    return { from: jest.fn().mockReturnValue({ where: whereMock }) };
  });
}

interface InsertCapture {
  insertMock: jest.Mock;
  getCaptured: () => unknown;
}

function makeInsertCapture(): InsertCapture {
  let capturedValues: unknown = undefined;
  const valuesMock = jest.fn().mockImplementation((v: unknown) => {
    capturedValues = v;
    return Promise.resolve(undefined);
  });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
  return { insertMock, getCaptured: () => capturedValues };
}

describe("ProjectsActivityService — project_id set on insert (ticket 16 writer coverage)", () => {
  it("logTicketActivity sets project_id on the inserted row so the row appears in the project feed query after migration", async () => {
    const capture = makeInsertCapture();
    const db = {
      insert: capture.insertMock,
      select: makeSelectTwoCalls(
        [{ id: MEMBERSHIP_ID }],
        [{ projectId: PROJECT_ID }],
      ),
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, noOpNotifications, noOpDispatch);
    await svc.logTicketActivity(ORG_ID, TICKET_ID, USER_ID, "created");

    const row = capture.getCaptured() as Record<string, unknown>;
    expect(row["projectId"]).toBe(PROJECT_ID);
  });

  it("logTicketActivity sets project_id from the ticket row so the value cannot drift from the FK target", async () => {
    const captureA = makeInsertCapture();
    const dbA = {
      insert: captureA.insertMock,
      select: makeSelectTwoCalls([{ id: 1 }], [{ projectId: 3 }]),
    } as unknown as Db;
    const svcA = new ProjectsActivityService(dbA, noOpNotifications, noOpDispatch);
    await svcA.logTicketActivity("org-a", 1, "user-a", "status_changed");
    expect((captureA.getCaptured() as Record<string, unknown>)["projectId"]).toBe(3);

    const captureB = makeInsertCapture();
    const dbB = {
      insert: captureB.insertMock,
      select: makeSelectTwoCalls([{ id: 2 }], [{ projectId: 9 }]),
    } as unknown as Db;
    const svcB = new ProjectsActivityService(dbB, noOpNotifications, noOpDispatch);
    await svcB.logTicketActivity("org-b", 2, "user-b", "status_changed");
    expect((captureB.getCaptured() as Record<string, unknown>)["projectId"]).toBe(9);
  });

  it("logTicketActivity sets project_id to null when the ticket has no project so orphaned activity rows do not associate with a stale project", async () => {
    const capture = makeInsertCapture();
    const db = {
      insert: capture.insertMock,
      select: makeSelectTwoCalls([{ id: MEMBERSHIP_ID }], []),
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, noOpNotifications, noOpDispatch);
    await svc.logTicketActivity(ORG_ID, TICKET_ID, USER_ID, "created");

    const row = capture.getCaptured() as Record<string, unknown>;
    expect(row["projectId"]).toBeNull();
  });

  it("logTicketFieldChanges sets project_id on every inserted entry so field-change events are filterable by project in the feed", async () => {
    const capture = makeInsertCapture();
    const db = {
      insert: capture.insertMock,
      select: makeSelectTwoCalls(
        [{ id: MEMBERSHIP_ID }],
        [{ projectId: PROJECT_ID }],
      ),
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, noOpNotifications, noOpDispatch);
    await svc.logTicketFieldChanges(
      ORG_ID,
      TICKET_ID,
      USER_ID,
      {
        title: "old title",
        status: "TODO",
        priority: "HIGH",
        assigneeId: null,
        dueDate: null,
        points: null,
        type: "TASK",
        cycleId: null,
      },
      { title: "new title" },
    );

    const rows = capture.getCaptured() as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row["projectId"] === PROJECT_ID)).toBe(true);
  });

  it("logTicketFieldChanges does not insert when the title is unchanged so unchanged fields produce no spurious activity rows", async () => {
    const capture = makeInsertCapture();
    const db = {
      insert: capture.insertMock,
      select: makeSelectTwoCalls([], []),
    } as unknown as Db;

    const svc = new ProjectsActivityService(db, noOpNotifications, noOpDispatch);
    await svc.logTicketFieldChanges(
      ORG_ID,
      TICKET_ID,
      USER_ID,
      {
        title: "same",
        status: "TODO",
        priority: "HIGH",
        assigneeId: null,
        dueDate: null,
        points: null,
        type: "TASK",
        cycleId: null,
      },
      { title: "same" },
    );

    expect(capture.insertMock).not.toHaveBeenCalled();
  });
});
