import { NotFoundException } from "@nestjs/common";
import { makeFakeDb } from "../../../test/fake-select-db";
import type { Db } from "../../../db/drizzle.module";
import { TaxDashboardService } from "./tax-dashboard.service";
import { TaxPaymentsService } from "./tax-payments.service";

const ORG = "org-1";
const USER = "user-1";
const TODAY = new Date().toISOString().slice(0, 10);

function payment(overrides: Record<string, unknown>) {
  return {
    id: 1,
    org_id: ORG,
    tax_type: "GST",
    amount: "100.0000",
    paid_date: TODAY,
    reference: "TP-1",
    period_start: TODAY,
    period_end: TODAY,
    journal_entry_id: 42,
    notes: null,
    created_by: USER,
    created_at: new Date(),
    archived_at: null,
    ...overrides,
  };
}

function memberRows() {
  return [{ id: 5, org_id: ORG, user_id: USER, role: "OWNER", is_owner: true, status: "ACTIVE" }];
}

describe("tax reads exclude archived payments", () => {
  it("the dashboard's recent payments omit an archived payment", async () => {
    const db = makeFakeDb({
      acc_tax_payments: [payment({ id: 1 }), payment({ id: 2, reference: "TP-2", archived_at: new Date() })],
      invoices: [],
      purchase_bills: [],
      journal_lines: [],
    });
    const cache = { cachedVersioned: (_ns: string, _key: string, factory: () => Promise<unknown>) => factory() };
    const posting = { resolveSystemAccount: jest.fn().mockResolvedValue(null) };
    const service = new TaxDashboardService(db as unknown as Db, cache as never, posting as never);

    const dashboard = await service.getDashboard(ORG, { from: TODAY, to: TODAY });

    expect(dashboard.recentPayments.map((row) => row.id)).toEqual([1]);
  });

  it("deleting an already-archived payment does not post a second journal reversal", async () => {
    const db = makeFakeDb({
      acc_tax_payments: [payment({ id: 1, archived_at: new Date() })],
      organization_members: memberRows(),
      organization_people: [],
      accounting_periods: [],
    });
    const reverseJournal = jest.fn();
    const service = new TaxPaymentsService(
      db as unknown as Db,
      { invalidateNamespace: jest.fn() } as never,
      { log: jest.fn() } as never,
      { dispatch: jest.fn() } as never,
      { reverseJournal } as never,
    );

    await expect(service.delete({ orgId: ORG, userId: USER } as never, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(reverseJournal).not.toHaveBeenCalled();
  });

  it("deleting a live payment still posts its journal reversal", async () => {
    const db = makeFakeDb({
      acc_tax_payments: [payment({ id: 1 })],
      organization_members: memberRows(),
      organization_people: [],
      accounting_periods: [],
    });
    const reverseJournal = jest.fn();
    const service = new TaxPaymentsService(
      db as unknown as Db,
      { invalidateNamespace: jest.fn() } as never,
      { log: jest.fn() } as never,
      { dispatch: jest.fn() } as never,
      { reverseJournal } as never,
    );

    await expect(service.delete({ orgId: ORG, userId: USER } as never, 1)).resolves.toEqual({
      archived: true,
    });
    expect(reverseJournal).toHaveBeenCalledTimes(1);
  });
});
