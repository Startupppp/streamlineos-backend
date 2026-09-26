import { notifications } from "../../db/schema";
import { MembershipResolvingDispatchDouble } from "../notifications/notification-recipient-membership.spec-fixtures";
import { LeadsService } from "./leads.service";

jest.mock("../party/party-legacy-leads", () => ({
  createMirroredLead: jest.fn(async (_db: unknown, _orgId: string, values: Record<string, unknown>) => ({
    id: 4242,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    ...values,
  })),
  softDeleteMirroredLeads: jest.fn(),
  updateMirroredLead: jest.fn(),
}));

jest.mock("./lead-triggers", () => ({
  evaluateAssignmentRules: jest.fn(async () => undefined),
  recalculateLeadScore: jest.fn(async () => null),
  applySlaPolicy: jest.fn(async () => undefined),
}));

const ORG_ID = "org-leads-assign";
const ACTOR_USER = "user-manager";
const ASSIGNEE_USER = "user-rep";
const ASSIGNEE_MEMBERSHIP_ID = 9101;

function buildService() {
  const insertedTables: unknown[] = [];
  const db = {
    query: {
      organizationMembers: {
        findFirst: async () => ({ userId: ASSIGNEE_USER }),
      },
    },
    insert: (table: unknown) => {
      insertedTables.push(table);
      return { values: async () => undefined };
    },
  };
  const dispatch = new MembershipResolvingDispatchDouble([
    { userId: ASSIGNEE_USER, membershipId: ASSIGNEE_MEMBERSHIP_ID },
  ]);
  const service = new LeadsService(
    db as never,
    { invalidateNamespace: jest.fn() } as never,
    { log: jest.fn() } as never,
    dispatch as never,
    { runAutomationsForEvent: jest.fn(async () => undefined) } as never,
    { dispatch: jest.fn() } as never,
    { evaluate: jest.fn(async () => ({ valid: true, errors: [] })) } as never,
    { emit: jest.fn(async () => undefined) } as never,
    { recordTouch: jest.fn(async () => undefined) } as never,
    {} as never,
    { getLead: jest.fn(async () => null) } as never,
    { assertWithinLimit: jest.fn(async () => undefined) } as never,
  );
  return { service, dispatch, insertedTables };
}

function countNotificationInserts(insertedTables: readonly unknown[]): number {
  return insertedTables.filter((table) => table === notifications).length;
}

const CREATE_INPUT = {
  name: "Acme Holdings",
  source: "referral",
  priority: "HIGH",
  assignedToId: ASSIGNEE_USER,
};

describe("LeadsService.create — the assignment notification reaches the assignee's inbox", () => {
  it("addresses the new assignee through the dispatcher, so the row carries their membership id", async () => {
    const { service, dispatch } = buildService();

    await service.create(ORG_ID, ACTOR_USER, CREATE_INPUT as never);
    await new Promise(setImmediate);

    expect(dispatch.eventKeys()).toEqual(["crm.lead.assigned"]);
    expect(dispatch.rowsFor(ASSIGNEE_USER)).toEqual([
      {
        orgId: ORG_ID,
        eventKey: "crm.lead.assigned",
        userId: ASSIGNEE_USER,
        membershipId: ASSIGNEE_MEMBERSHIP_ID,
      },
    ]);
  });

  it("never inserts into notifications itself, because a hand-built row leaves membership_id null and no reader can see it", async () => {
    const { service, insertedTables } = buildService();

    await service.create(ORG_ID, ACTOR_USER, CREATE_INPUT as never);
    await new Promise(setImmediate);

    expect(countNotificationInserts(insertedTables)).toBe(0);
  });

  it("tells the assignee once in total, where the raw insert used to add an invisible second copy", async () => {
    const { service, dispatch, insertedTables } = buildService();

    await service.create(ORG_ID, ACTOR_USER, CREATE_INPUT as never);
    await new Promise(setImmediate);

    expect(dispatch.rows.length + countNotificationInserts(insertedTables)).toBe(1);
  });

  it("sends nothing when the lead is created unassigned", async () => {
    const { service, dispatch, insertedTables } = buildService();

    await service.create(ORG_ID, ACTOR_USER, { ...CREATE_INPUT, assignedToId: undefined } as never);
    await new Promise(setImmediate);

    expect(dispatch.rows).toEqual([]);
    expect(countNotificationInserts(insertedTables)).toBe(0);
  });
});
