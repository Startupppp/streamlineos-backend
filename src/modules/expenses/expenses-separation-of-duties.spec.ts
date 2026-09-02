import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpensesService } from "./expenses.service";
import { expenseOwnerPredicate, SELF_ONLY_SCOPE, type ExpenseReadScope } from "./expenses-scope";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const ORG = "org-1";
const APPROVER = "user-approver";
const EXPENSE_ID = 11;

function actor(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "HR",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function memberSelect() {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { id: 99, orgId: ORG, userId: APPROVER, role: "MEMBER", isOwner: false, status: "ACTIVE" },
        ]),
      }),
    }),
  });
}

describe("an expense owner cannot decide on their own claim", () => {
  it("approveExpense refuses when the approver submitted the expense", async () => {
    const db = {
      query: {
        expenses: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: EXPENSE_ID, orgId: ORG, userId: APPROVER, status: "PENDING" }),
        },
        finApprovalRequests: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: memberSelect(),
    } as unknown as Db;

    const svc = new ExpenseLifecycleService(
      db,
      { invalidateNamespace: jest.fn() } as never,
      { log: jest.fn() } as never,
      { postExpense: jest.fn() } as never,
    );

    await expect(svc.approveExpense(actor(APPROVER), EXPENSE_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("approveExpense proceeds past the ownership gate for someone else's expense", async () => {
    const db = {
      query: {
        expenses: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: EXPENSE_ID, orgId: ORG, userId: "someone-else", status: "PENDING" }),
        },
        finApprovalRequests: { findFirst: jest.fn().mockResolvedValue(null) },
        expenseCategories: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: memberSelect(),
    } as unknown as Db;

    const svc = new ExpenseLifecycleService(
      db,
      { invalidateNamespace: jest.fn() } as never,
      { log: jest.fn() } as never,
      { postExpense: jest.fn().mockResolvedValue({ entryId: 1 }) } as never,
    );

    const rejection = await svc.approveExpense(actor(APPROVER), EXPENSE_ID).catch((e: unknown) => e);
    expect(rejection).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("the status-change path enforces the same separation and stays tenant-scoped", () => {
  it("refuses a self decision inside the transaction", async () => {
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest
              .fn()
              .mockResolvedValue([{ id: EXPENSE_ID, orgId: ORG, userId: APPROVER, status: "PENDING" }]),
          }),
        }),
      }),
      update: jest.fn(),
    };
    const db = {
      select: memberSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ExpensesWriteService(
      db,
      { invalidateNamespace: jest.fn() } as never,
      { log: jest.fn() } as never,
    );

    await expect(
      svc.update(actor(APPROVER), true, EXPENSE_ID, { status: "APPROVED" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe("the expense read scope is applied at the data layer, not discarded", () => {
  function values(node: unknown, seen = new Set<object>()): unknown[] {
    if (node === null || typeof node !== "object") return [];
    if (seen.has(node as object)) return [];
    seen.add(node as object);
    const out: unknown[] = [];
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (typeof v === "string") out.push(v);
      else out.push(...values(v, seen));
    }
    return out;
  }

  it("an approver scoped to own cannot widen to another employee via the userId filter", () => {
    const predicate = expenseOwnerPredicate(SELF_ONLY_SCOPE, "me", "someone-else");
    expect(values(predicate)).toContain("me");
    expect(values(predicate)).not.toContain("someone-else");
  });

  it("an approver scoped to team sees themselves and their direct reports only", () => {
    const team: ExpenseReadScope = { scope: "team", teamUserIds: ["report-a", "report-b"] };
    const predicate = expenseOwnerPredicate(team, "manager");
    const seen = values(predicate);
    expect(seen).toContain("manager");
    expect(seen).toContain("report-a");
    expect(seen).toContain("report-b");
  });

  it("a team-scoped approver is still refused an employee outside their reports", () => {
    const team: ExpenseReadScope = { scope: "team", teamUserIds: ["report-a"] };
    const predicate = expenseOwnerPredicate(team, "manager", "outsider");
    expect(values(predicate)).not.toContain("outsider");
  });

  it("only an all-scoped approver reads the whole organization", () => {
    expect(expenseOwnerPredicate({ scope: "all", teamUserIds: [] }, "me")).toBeUndefined();
  });

  it("list keeps the resolved scope in its cache key so scopes cannot share a cached page", () => {
    const cachedVersioned = jest.fn().mockResolvedValue({ data: [] });
    const svc = new ExpensesService(
      { query: { expenses: { findMany: jest.fn() } }, select: jest.fn() } as unknown as Db,
      { cachedVersioned } as never,
      { log: jest.fn() } as never,
    );

    void svc.list(ORG, "me", SELF_ONLY_SCOPE, { page: 1, limit: 20 } as never);
    void svc.list(ORG, "me", { scope: "all", teamUserIds: [] }, { page: 1, limit: 20 } as never);

    const firstKey = cachedVersioned.mock.calls[0]?.[1] as string;
    const secondKey = cachedVersioned.mock.calls[1]?.[1] as string;
    expect(firstKey).not.toEqual(secondKey);
  });
});
