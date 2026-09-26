import { clientAccountActivities, incentiveConfig, incentives, notifications } from "../../../db/schema";
import { ScopedRead } from "../../access/scoped-read";
import { MembershipResolvingDispatchDouble } from "../../notifications/notification-recipient-membership.spec-fixtures";
import { updateClientStatus } from "./client-investment";

const ORG_ID = "org-clients-investment";
const ACTOR_USER = "user-relationship-manager";
const ACCOUNT_ID = 812;
const SALES_REP_USER = "user-sales-rep";
const SALES_REP_MEMBERSHIP_ID = 3301;
const HR_USER = "user-hr-lead";
const HR_MEMBERSHIP_ID = 3302;

const ACCOUNT = {
  id: ACCOUNT_ID,
  orgId: ORG_ID,
  clientName: "Vasudev Trading",
  salesRepId: SALES_REP_USER,
  branchId: 4,
};

function buildDeps(options: { salesRepId?: string | null; hrUserIds?: string[] } = {}) {
  const { salesRepId = SALES_REP_USER, hrUserIds = [HR_USER] } = options;
  const insertedTables: unknown[] = [];
  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ ...ACCOUNT, salesRepId, status: "INVESTED" }],
        }),
      }),
    }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return { values: async () => undefined };
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (table === incentiveConfig ? [{ incentiveRate: "2.5" }] : []),
          }),
        }),
      }),
    }),
  };
  const db = {
    query: { clientAccounts: { findFirst: async () => ({ ...ACCOUNT, salesRepId }) } },
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const dispatch = new MembershipResolvingDispatchDouble([
    { userId: SALES_REP_USER, membershipId: SALES_REP_MEMBERSHIP_ID },
    { userId: HR_USER, membershipId: HR_MEMBERSHIP_ID },
  ]);
  const deps = {
    db: db as never,
    audit: { log: jest.fn() } as never,
    clientsEmail: { sendInvestmentEmails: jest.fn(async () => undefined) } as never,
    access: {
      membersWithPermission: jest.fn(async () => hrUserIds.map((userId) => ({ userId }))),
    } as never,
    dispatch: dispatch as never,
  };
  const read = ScopedRead.of(ORG_ID, ACTOR_USER, "all");
  return { deps, read, dispatch, insertedTables };
}

function countNotificationInserts(insertedTables: readonly unknown[]): number {
  return insertedTables.filter((table) => table === notifications).length;
}

const INVESTED_INPUT = {
  status: "INVESTED",
  investmentAmount: "500000",
  planName: "Growth",
};

describe("updateClientStatus — the investment notice reaches the rep and HR through the dispatcher", () => {
  it("addresses the sales rep by membership id when the client invests", async () => {
    const { deps, read, dispatch } = buildDeps();

    await updateClientStatus(deps, read, ACCOUNT_ID, INVESTED_INPUT as never);

    expect(dispatch.rowsFor(SALES_REP_USER)).toEqual([
      {
        orgId: ORG_ID,
        eventKey: "crm.client.invested",
        userId: SALES_REP_USER,
        membershipId: SALES_REP_MEMBERSHIP_ID,
      },
    ]);
  });

  it("addresses every hr:employees:manage holder by membership id too, not by bare user id", async () => {
    const { deps, read, dispatch } = buildDeps();

    await updateClientStatus(deps, read, ACCOUNT_ID, INVESTED_INPUT as never);

    expect(dispatch.rowsFor(HR_USER)).toEqual([
      {
        orgId: ORG_ID,
        eventKey: "crm.client.invested",
        userId: HR_USER,
        membershipId: HR_MEMBERSHIP_ID,
      },
    ]);
  });

  it("never inserts into notifications itself, because a hand-built row leaves membership_id null and no reader can see it", async () => {
    const { deps, read, insertedTables } = buildDeps();

    await updateClientStatus(deps, read, ACCOUNT_ID, INVESTED_INPUT as never);

    expect(countNotificationInserts(insertedTables)).toBe(0);
  });

  it("still books the incentive and the activity inside the transaction, so moving the notification out did not move the money with it", async () => {
    const { deps, read, insertedTables } = buildDeps();

    await updateClientStatus(deps, read, ACCOUNT_ID, INVESTED_INPUT as never);

    expect(insertedTables.filter((table) => table === incentives)).toHaveLength(1);
    expect(insertedTables.filter((table) => table === clientAccountActivities)).toHaveLength(1);
  });

  it("emits nothing when an account with no sales rep and no hr holders invests, rather than addressing a null recipient", async () => {
    const { deps, read, dispatch } = buildDeps({ salesRepId: null, hrUserIds: [] });

    await updateClientStatus(deps, read, ACCOUNT_ID, INVESTED_INPUT as never);

    expect(dispatch.inputs).toEqual([]);
  });

  it("emits nothing for a status change that is not an investment", async () => {
    const { deps, read, dispatch, insertedTables } = buildDeps();

    await updateClientStatus(deps, read, ACCOUNT_ID, { status: "CONTACTED" } as never);

    expect(dispatch.inputs).toEqual([]);
    expect(countNotificationInserts(insertedTables)).toBe(0);
  });
});
