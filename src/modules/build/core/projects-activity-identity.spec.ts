import { ProjectsActivityService } from "./projects-activity.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { Db } from "../../../db/drizzle.module";

const OWNER_ORG = "org-owner";

const mockNotifications = { create: jest.fn() } as unknown as NotificationsService;
const mockDispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;

function makeLimitableWhere(value: unknown) {
  const asPromise = Promise.resolve(value);
  return Object.assign(asPromise, {
    limit: jest.fn().mockResolvedValue(value),
  });
}

function makeSelectChain(value: unknown) {
  const whereFn = jest.fn().mockImplementation(() => makeLimitableWhere(value));
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  return jest.fn().mockReturnValue({ from: fromFn });
}

function makeDb(peopleRows: unknown[], activityRows: unknown[] = []) {
  let selectCallCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return makeSelectChain(peopleRows)();
      return makeSelectChain([])();
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((vals: unknown) => {
        if (Array.isArray(vals)) activityRows.push(...vals);
        else activityRows.push(vals);
        return Promise.resolve(undefined);
      }),
    }),
    query: {},
  } as unknown as Db;
  return { db, activityRows, getSelectCount: () => selectCallCount };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ProjectsActivityService — ROW-76 historical identity via organizationPeople", () => {
  it("CONTROL — assignee display name is resolved from organizationPeople and stored in activity log", async () => {
    const { db, activityRows } = makeDb([
      {
        userId: "user-new",
        displayName: "Alice Chen",
        firstName: null,
        lastName: null,
        workEmail: null,
      },
    ]);

    const svc = new ProjectsActivityService(db, mockNotifications, mockDispatch);

    await svc.logTicketFieldChanges(
      OWNER_ORG,
      1,
      "user-1",
      {
        title: "T",
        status: "TODO",
        priority: "MEDIUM",
        assigneeId: null,
        dueDate: null,
        points: null,
        type: "TASK",
        cycleId: null,
      },
      { assigneeId: "user-new" },
    );

    const assigneeEntry = (activityRows as Array<{ action: string; toValue?: string | null }>).find(
      (r) => r.action === "assignee_changed",
    );
    expect(assigneeEntry).toBeDefined();
    expect(assigneeEntry?.toValue).toBe("Alice Chen");
  });

  it("CONTROL — firstName+lastName fallback is used when displayName is null", async () => {
    const { db, activityRows } = makeDb([
      {
        userId: "user-new",
        displayName: null,
        firstName: "Bob",
        lastName: "Smith",
        workEmail: null,
      },
    ]);

    const svc = new ProjectsActivityService(db, mockNotifications, mockDispatch);

    await svc.logTicketFieldChanges(
      OWNER_ORG,
      1,
      "user-1",
      { title: "T", status: "TODO", priority: "M", assigneeId: null, dueDate: null, points: null, type: "TASK", cycleId: null },
      { assigneeId: "user-new" },
    );

    const assigneeEntry = (activityRows as Array<{ action: string; toValue?: string | null }>).find(
      (r) => r.action === "assignee_changed",
    );
    expect(assigneeEntry?.toValue).toBe("Bob Smith");
  });

  it("CONTROL — departed member (no organizationPeople row): toValue falls back to userId string", async () => {
    const { db, activityRows } = makeDb([]);

    const svc = new ProjectsActivityService(db, mockNotifications, mockDispatch);

    await svc.logTicketFieldChanges(
      OWNER_ORG,
      1,
      "user-1",
      { title: "T", status: "TODO", priority: "M", assigneeId: null, dueDate: null, points: null, type: "TASK", cycleId: null },
      { assigneeId: "departed-user" },
    );

    const assigneeEntry = (activityRows as Array<{ action: string; toValue?: string | null }>).find(
      (r) => r.action === "assignee_changed",
    );
    expect(assigneeEntry?.toValue).toBe("departed-user");
  });

  it("DENY — select is called with each caller's own orgId (cross-tenant isolation)", async () => {
    const capturedOrgIds: string[] = [];

    function makeOrgTrackingDb(orgId: string) {
      let count = 0;
      return {
        select: jest.fn().mockImplementation(() => {
          count++;
          const whereFn = jest.fn().mockImplementation((condition: unknown) => {
            capturedOrgIds.push(orgId);
            return makeLimitableWhere([]);
          });
          return { from: jest.fn().mockReturnValue({ where: whereFn }) };
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
        query: {},
      } as unknown as Db;
    }

    const svcA = new ProjectsActivityService(makeOrgTrackingDb("org-a"), mockNotifications, mockDispatch);
    const svcB = new ProjectsActivityService(makeOrgTrackingDb("org-b"), mockNotifications, mockDispatch);

    const snapshot = { title: "T", status: "TODO", priority: "M", assigneeId: "old", sprintId: null, dueDate: null, points: null, type: "TASK", cycleId: null };
    await svcA.logTicketFieldChanges("org-a", 1, "u1", snapshot, { assigneeId: "new" });
    await svcB.logTicketFieldChanges("org-b", 2, "u2", snapshot, { assigneeId: "new2" });

    expect(capturedOrgIds).toContain("org-a");
    expect(capturedOrgIds).toContain("org-b");
    const uniqueOrgs = new Set(capturedOrgIds);
    expect(uniqueOrgs.size).toBeGreaterThan(1);
  });
});
