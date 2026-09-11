/**
 * The owner-only override on expense approval.
 *
 * `finance.expense.grant-without-approval` exists so the person who may skip an
 * approval control is not the person that control exists to check. Nothing
 * asserted it: neutering the `holdsOwnerOnly` branch in approveExpense left the
 * whole expenses unit suite green, which is why this file exists.
 */
const mockAssertOrganizationActor = jest.fn();

jest.mock("../../common/organization/organization-actor", () => {
  const actual = jest.requireActual(
    "../../common/organization/organization-actor",
  );
  return {
    ...actual,
    assertOrganizationActor: (...args: unknown[]) =>
      mockAssertOrganizationActor(...args),
  };
});

import { BadRequestException } from "@nestjs/common";
import { approveExpense } from "./lib/expense-approval";
import type { ExpenseApprovalDeps } from "./lib/expense-approval";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-1";
const EXPENSE_ID = 77;

const EXPENSE_ROW = {
  id: EXPENSE_ID,
  orgId: ORG,
  userId: "user-claimant",
  status: "SUBMITTED",
  amount: "120.00",
  taxAmount: "20.00",
  category: "Travel",
  description: "Taxi",
  expenseDate: "2026-09-01",
  categoryId: null,
};

const OPEN_APPROVAL = { id: 900, status: "PENDING" };

function actor(isOrgOwner: boolean): CurrentUserContext {
  return {
    userId: "user-approver",
    orgId: ORG,
    principal: { kind: "human-session", isOrgOwner },
  } as unknown as CurrentUserContext;
}

function makeDeps(openApproval: unknown) {
  const approvalRequestUpdates: unknown[] = [];
  const expenseUpdates: unknown[] = [];

  const updateChain = (sink: unknown[]) => ({
    set: (values: unknown) => {
      sink.push(values);
      return {
        where: jest.fn().mockResolvedValue(undefined),
        returning: jest.fn().mockResolvedValue([{ id: EXPENSE_ID }]),
      };
    },
  });

  const db = {
    query: {
      expenses: { findFirst: jest.fn().mockResolvedValue(EXPENSE_ROW) },
      finApprovalRequests: {
        findFirst: jest.fn().mockResolvedValue(openApproval),
      },
      expenseCategories: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    update: jest.fn().mockImplementation(() => updateChain(approvalRequestUpdates)),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: jest.fn().mockImplementation(() => ({
          set: (values: unknown) => {
            expenseUpdates.push(values);
            return {
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ id: EXPENSE_ID }]),
              }),
            };
          },
        })),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
        // The outbox emitter reads max(aggregate_version) and stops at .where().
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxVersion: 0 }]),
          }),
        }),
      }),
    ),
  } as unknown as Db;

  const posting = { postJournal: jest.fn().mockResolvedValue({ entryId: 555 }) };

  const deps: ExpenseApprovalDeps = {
    db,
    cache: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    audit: { log: jest.fn() } as never,
    posting: posting as never,
  };

  return { deps, posting, approvalRequestUpdates, expenseUpdates };
}

describe("approveExpense — the owner-only override on a pending approval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertOrganizationActor.mockResolvedValue({
      membershipId: "mem-approver",
    });
  });

  it("refuses a non-owner while an approval request is still PENDING", async () => {
    const { deps, posting } = makeDeps(OPEN_APPROVAL);

    await expect(
      approveExpense(deps, actor(false), EXPENSE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The refusal must land BEFORE the ledger is touched.
    expect(posting.postJournal).not.toHaveBeenCalled();
  });

  it("lets the org owner grant over a pending approval, marking it APPROVED", async () => {
    const { deps, posting, approvalRequestUpdates } = makeDeps(OPEN_APPROVAL);

    const result = await approveExpense(deps, actor(true), EXPENSE_ID);

    expect(result).toEqual({ success: true, entryId: 555 });
    expect(approvalRequestUpdates).toHaveLength(1);
    expect(approvalRequestUpdates[0]).toMatchObject({ status: "APPROVED" });
    expect(posting.postJournal).toHaveBeenCalledTimes(1);
  });

  it("does not consult the override when no approval request is open", async () => {
    const { deps, posting, approvalRequestUpdates } = makeDeps(null);

    const result = await approveExpense(deps, actor(false), EXPENSE_ID);

    expect(result).toEqual({ success: true, entryId: 555 });
    expect(approvalRequestUpdates).toHaveLength(0);
    expect(posting.postJournal).toHaveBeenCalledTimes(1);
  });

  it("splits tax out of the debit and credits the gross to the employee", async () => {
    const { deps, posting } = makeDeps(null);

    await approveExpense(deps, actor(false), EXPENSE_ID);

    const lines = posting.postJournal.mock.calls[0]?.[1]?.lines as Array<
      Record<string, unknown>
    >;
    // 120.00 gross, 20.00 tax: the expense debit is the net 100.00, the tax
    // sits on its own debit, and the employee is owed the full 120.00.
    expect(lines).toEqual([
      expect.objectContaining({
        systemPurpose: "EXPENSE_CLEARING",
        debit: "100.00",
      }),
      expect.objectContaining({
        systemPurpose: "TAX_RECEIVABLE",
        debit: "20.00",
      }),
      expect.objectContaining({
        systemPurpose: "REIMBURSEMENT_PAYABLE",
        credit: "120.00",
      }),
    ]);
  });
});
