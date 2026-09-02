import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { finApprovalRequests, organizationMembers, purchaseBills } from "../../../db/schema";
import { BillsWorkflowService } from "./bills-workflow.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-1";
const BILL_ID = 12;
const SUBMITTER = "user-submitter";

function actor(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "FINANCE",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeDb(requestedBy: string) {
  const billRow = {
    id: BILL_ID,
    orgId: ORG,
    status: "PENDING_APPROVAL",
    billNumber: "BILL-1",
    billDate: "2026-08-01",
    subtotal: "100",
    discount: "0",
    cgstAmount: "0",
    sgstAmount: "0",
    igstAmount: "0",
    total: "100",
    supplierGstin: null,
    placeOfSupply: "27",
  };
  const memberRow = {
    id: 99,
    orgId: ORG,
    userId: SUBMITTER,
    role: "MEMBER",
    isOwner: false,
    status: "ACTIVE",
  };
  const approvalRow = { id: 1, status: "PENDING", requestedBy };

  function rowsForTable(table: unknown): unknown[] {
    if (table === purchaseBills) return [billRow];
    if (table === finApprovalRequests) return [approvalRow];
    if (table === organizationMembers) return [memberRow];
    return [];
  }

  const transaction = jest.fn();
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockImplementation((table: unknown) => ({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rowsForTable(table)),
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rowsForTable(table)),
          }),
        }),
      })),
    }),
    transaction,
  } as unknown as Db;
  return { db, transaction };
}

describe("a purchase bill cannot be approved by the person who submitted it for approval", () => {
  it("refuses the submitter and never opens the posting transaction", async () => {
    const { db, transaction } = makeDb(SUBMITTER);
    const svc = new BillsWorkflowService(
      db,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
      { postJournal: jest.fn() } as never,
      { seedChartOfAccountsForOrg: jest.fn(), postPurchaseBill: jest.fn() } as never,
    );

    await expect(svc.approveBill(actor(SUBMITTER), BILL_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("lets a different approver past the separation gate", async () => {
    const { db } = makeDb(SUBMITTER);
    const svc = new BillsWorkflowService(
      db,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
      { postJournal: jest.fn() } as never,
      {
        seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
        postPurchaseBill: jest.fn(),
      } as never,
    );

    const outcome = await svc.approveBill(actor("user-approver"), BILL_ID).catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(ForbiddenException);
  });
});
