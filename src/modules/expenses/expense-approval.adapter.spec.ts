import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import type { ApprovalSourceAdapter } from "../attention/approval-adapter.registry";
import {
  ExpenseApprovalAdapter,
  EXPENSE_APPROVAL_DEEP_LINK,
} from "./expense-approval.adapter";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const APPROVER = 11;
const OTHER_APPROVER = 22;

function expenseRow(
  id: number,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    org_id: ORG,
    user_id: "claimant-user",
    user_membership_id: 9,
    category: "Travel",
    amount: "250.00",
    currency: "INR",
    status: "PENDING",
    approver_membership_id: APPROVER,
    expense_date: "2026-09-18",
    created_at: new Date(`2026-09-${String(10 + id).padStart(2, "0")}T00:00:00.000Z`),
    ...overrides,
  };
}

function userRows() {
  return [
    {
      id: "claimant-user",
      name: "Priya Nair",
      first_name: "Priya",
      last_name: "Nair",
      image: null,
      email: "priya@example.com",
    },
  ];
}

function tables(rows: Record<string, unknown>[]): TableRows {
  return { expenses: rows, users: userRows() };
}

function makeAdapter(rows: Record<string, unknown>[]): ApprovalSourceAdapter {
  const db = makeFakeDb(tables(rows)) as unknown as Db;
  const registry = new ApprovalAdapterRegistry();
  new ExpenseApprovalAdapter(db, registry).onModuleInit();
  const adapter = registry.list()[0];
  if (adapter === undefined) throw new Error("expense adapter did not register");
  return adapter;
}

describe("expense approvals reach the unified inbox", () => {
  it("registers under the expenses module with the key the approve route enforces", () => {
    const adapter = makeAdapter([]);
    expect(adapter.module).toBe("expenses");
    expect(adapter.kindLabel).toBe("expense");
    expect(adapter.permission).toBe("hr:expenses:approve");
  });

  it("sends the reader to Expenses, not to Build approvals", async () => {
    const adapter = makeAdapter([expenseRow(1)]);
    const items = await adapter.fetch(ORG, "u", APPROVER, 10, null);

    expect(items).toHaveLength(1);
    expect(items[0]?.deepLink).toBe(EXPENSE_APPROVAL_DEEP_LINK);
    expect(items[0]?.deepLink).not.toContain("/build/");
    expect(items[0]?.approvalKind).toBe("expense");
    expect(items[0]?.sourceModule).toBe("expenses");
  });

  it("names the claimant and the amount so the row is actionable without opening it", async () => {
    const adapter = makeAdapter([expenseRow(1)]);
    const items = await adapter.fetch(ORG, "u", APPROVER, 10, null);

    expect(items[0]?.subject).toBe("Travel · INR 250.00");
    expect(items[0]?.actor?.name).toBe("Priya Nair");
  });

  it("returns only claims routed to this approver in this org", async () => {
    const adapter = makeAdapter([
      expenseRow(1),
      expenseRow(2, { approver_membership_id: OTHER_APPROVER }),
      expenseRow(3, { org_id: OTHER_ORG }),
      expenseRow(4, { status: "APPROVED" }),
    ]);

    const items = await adapter.fetch(ORG, "u", APPROVER, 10, null);

    expect(items.map((i) => i.id)).toEqual([1]);
  });

  it("registers no private count query, so the badge scan and the list cannot diverge", () => {
    const adapter = makeAdapter([expenseRow(1)]);

    expect(adapter).not.toHaveProperty("countPending");
  });

  it("scans exactly the claims it would list, ignoring other approvers, other orgs and settled claims", async () => {
    const adapter = makeAdapter([
      expenseRow(1),
      expenseRow(2),
      expenseRow(3, { approver_membership_id: OTHER_APPROVER }),
      expenseRow(4, { org_id: OTHER_ORG }),
      expenseRow(5, { status: "APPROVED" }),
    ]);

    const items = await adapter.fetch(ORG, "u", APPROVER, 50, null);

    expect(items).toHaveLength(2);
  });

  it("lists nothing for a principal with no membership, while the same rows list for one that has", async () => {
    const adapter = makeAdapter([expenseRow(1)]);

    await expect(adapter.fetch(ORG, "u", null, 10, null)).resolves.toEqual([]);
    await expect(adapter.fetch(ORG, "u", APPROVER, 10, null)).resolves.toHaveLength(1);
  });

  it("pages newest first and resumes after the cursor without repeating a row", async () => {
    const adapter = makeAdapter([expenseRow(1), expenseRow(2), expenseRow(3)]);

    const first = await adapter.fetch(ORG, "u", APPROVER, 2, null);
    expect(first.map((i) => i.id)).toEqual([3, 2]);

    const last = first[first.length - 1];
    if (last === undefined) throw new Error("expected a first page");
    const second = await adapter.fetch(ORG, "u", APPROVER, 2, {
      id: last.id,
      t: last.timestamp,
    });

    expect(second.map((i) => i.id)).toEqual([1]);
  });
});
