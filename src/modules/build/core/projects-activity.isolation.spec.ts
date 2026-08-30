import { ProjectsActivityService } from "./projects-activity.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { Db } from "../../../db/drizzle.module";

function makeInsertMock() {
  return jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });
}

function makeEmptySelectMock() {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
  });
}

const mockNotifications = { send: jest.fn() } as unknown as NotificationsService;
const mockDispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;

beforeEach(() => {
  jest.resetAllMocks();
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
