import { commissions, deals, notifications } from "../../../db/schema";
import { MembershipResolvingDispatchDouble } from "../../notifications/notification-recipient-membership.spec-fixtures";
import { updateCommission } from "./sales-commissions";

const ORG_ID = "org-sales-commission";
const COMMISSION_ID = 3301;
const EARNER_USER = "user-account-executive";
const EARNER_MEMBERSHIP_ID = 7702;

function buildDeps() {
  const insertedTables: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === commissions)
              return [
                {
                  id: COMMISSION_ID,
                  status: "pending",
                  userId: EARNER_USER,
                  dealId: 55,
                  commissionAmount: "12500",
                },
              ];
            if (table === deals) return [{ name: "Northwind renewal" }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: COMMISSION_ID, status: "paid" }],
        }),
      }),
    }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return { values: async () => undefined };
    },
  };
  const dispatch = new MembershipResolvingDispatchDouble([
    { userId: EARNER_USER, membershipId: EARNER_MEMBERSHIP_ID },
  ]);
  const deps = {
    db: db as never,
    cache: { invalidateNamespace: jest.fn(async () => undefined) } as never,
    dispatch: dispatch as never,
  };
  return { deps, dispatch, insertedTables };
}

function countNotificationInserts(insertedTables: readonly unknown[]): number {
  return insertedTables.filter((table) => table === notifications).length;
}

describe("updateCommission — the person who earned the money is told through the dispatcher", () => {
  it("addresses the commission earner by membership id when the commission is paid", async () => {
    const { deps, dispatch } = buildDeps();

    await updateCommission(deps, ORG_ID, COMMISSION_ID, "paid");

    expect(dispatch.rowsFor(EARNER_USER)).toEqual([
      {
        orgId: ORG_ID,
        eventKey: "sales.commission.paid",
        userId: EARNER_USER,
        membershipId: EARNER_MEMBERSHIP_ID,
      },
    ]);
  });

  it("uses the approved event key rather than the paid one when the commission is only approved", async () => {
    const { deps, dispatch } = buildDeps();

    await updateCommission(deps, ORG_ID, COMMISSION_ID, "approved");

    expect(dispatch.eventKeys()).toEqual(["sales.commission.approved"]);
    expect(dispatch.rowsFor(EARNER_USER)[0]?.membershipId).toBe(EARNER_MEMBERSHIP_ID);
  });

  it("never inserts into notifications itself, because a hand-built row leaves membership_id null and no reader can see it", async () => {
    const { deps, insertedTables } = buildDeps();

    await updateCommission(deps, ORG_ID, COMMISSION_ID, "paid");

    expect(countNotificationInserts(insertedTables)).toBe(0);
  });

  it("carries the deal name and the amount into the message the earner reads", async () => {
    const { deps, dispatch } = buildDeps();

    await updateCommission(deps, ORG_ID, COMMISSION_ID, "paid");

    expect(dispatch.inputs[0]?.message).toContain("Northwind renewal");
    expect(dispatch.inputs[0]?.entityId).toBe(String(COMMISSION_ID));
  });
});
