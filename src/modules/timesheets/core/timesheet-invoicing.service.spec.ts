import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import {
  INVOICEABLE_ENTRY_CAP,
  TimesheetInvoicingService,
} from "./timesheet-invoicing.service";

const ORG = "org-ts-1";

interface StoredEntry {
  id: number;
  projectId: number | null;
  projectName: string | null;
  date: string;
  hours: string;
  billRate: string | null;
  currency: string | null;
  description: string | null;
  status: string;
  isBillable: boolean;
  invoicingStatus: string;
  voidedAt: Date | null;
}

function entry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 1,
    projectId: 10,
    projectName: "Website",
    date: "2026-09-01",
    hours: "4.00",
    billRate: "150.00",
    currency: "INR",
    description: "Design pass",
    status: "APPROVED",
    isBillable: true,
    invoicingStatus: "UNINVOICED",
    voidedAt: null,
    ...overrides,
  };
}

interface SelectChain {
  from: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

describe("TimesheetInvoicingService", () => {
  let service: TimesheetInvoicingService;
  let selectRows: StoredEntry[];
  let limitSpy: jest.Mock;

  const makeSelectChain = (): SelectChain => {
    const chain: SelectChain = {
      from: jest.fn(() => chain),
      leftJoin: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: limitSpy,
    };
    return chain;
  };

  beforeEach(async () => {
    selectRows = [];
    limitSpy = jest.fn(() => Promise.resolve(selectRows));

    const mockDb = { select: jest.fn(() => makeSelectChain()) };

    const module = await Test.createTestingModule({
      providers: [
        TimesheetInvoicingService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(TimesheetInvoicingService);
  });

  describe("loadInvoiceableEntries", () => {
    it("returns the priced shape an invoice line needs, so the caller re-keys nothing the entry already holds", async () => {
      selectRows = [entry({ id: 77 })];

      const loaded = await service.loadInvoiceableEntries(ORG, [77]);

      expect(loaded).toEqual([
        {
          id: 77,
          projectId: 10,
          projectName: "Website",
          date: "2026-09-01",
          hours: "4.00",
          billRate: "150.00",
          currency: "INR",
          description: "Design pass",
        },
      ]);
    });

    it("answers 404 and not 403 for an id that resolves in another organization, which would otherwise confirm the row exists", async () => {
      selectRows = [];

      await expect(
        service.loadInvoiceableEntries(ORG, [4242]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses time that has not been approved, because approval is what makes an hour billable", async () => {
      selectRows = [entry({ id: 77, status: "PENDING" })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a rejected entry by the same rule that refuses a pending one", async () => {
      selectRows = [entry({ id: 77, status: "REJECTED" })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a voided entry, voiding being the only deletion a timesheet has", async () => {
      selectRows = [entry({ id: 77, voidedAt: new Date("2026-09-02T00:00:00Z") })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses non-billable time, which no billing read in this module has ever selected", async () => {
      selectRows = [entry({ id: 77, isBillable: false })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("answers 409 for an entry already INVOICED, so the same hour cannot be billed twice", async () => {
      selectRows = [entry({ id: 77, invoicingStatus: "INVOICED" })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("admits an entry left at INVOICE_DRAFTED, because createInvoiceDraft leaves every entry it selects there and none of them has been billed", async () => {
      selectRows = [entry({ id: 77, invoicingStatus: "INVOICE_DRAFTED" })];

      const loaded = await service.loadInvoiceableEntries(ORG, [77]);

      expect(loaded.map((row) => row.id)).toEqual([77]);
    });

    it("refuses an entry with no bill rate rather than silently pricing it at zero", async () => {
      selectRows = [entry({ id: 77, billRate: null })];

      await expect(
        service.loadInvoiceableEntries(ORG, [77]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a selection over the cap before it reaches the database", async () => {
      const ids = Array.from({ length: INVOICEABLE_ENTRY_CAP + 1 }, (_, i) => i + 1);

      await expect(
        service.loadInvoiceableEntries(ORG, ids),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(limitSpy).not.toHaveBeenCalled();
    });

    it("bounds the read at the cap so a caller cannot widen it", async () => {
      selectRows = [entry({ id: 77 })];

      await service.loadInvoiceableEntries(ORG, [77]);

      expect(limitSpy).toHaveBeenCalledWith(INVOICEABLE_ENTRY_CAP);
    });
  });

  describe("markEntriesInvoiced", () => {
    it("reports only the rows it actually claimed, which is how the caller detects a concurrent biller", async () => {
      const returning = jest.fn().mockResolvedValue([{ id: 77 }]);
      const where = jest.fn(() => ({ returning }));
      const set = jest.fn(() => ({ where }));
      const tx = { update: jest.fn(() => ({ set })) };

      const claimed = await service.markEntriesInvoiced(
        tx as never,
        ORG,
        [77, 78],
      );

      expect(claimed).toBe(1);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ invoicingStatus: "INVOICED" }),
      );
    });

    it("writes through the transaction handle it is given and never through its own connection", async () => {
      const returning = jest.fn().mockResolvedValue([{ id: 77 }]);
      const tx = {
        update: jest.fn(() => ({ set: () => ({ where: () => ({ returning }) }) })),
      };

      await service.markEntriesInvoiced(tx as never, ORG, [77]);

      expect(tx.update).toHaveBeenCalledTimes(1);
    });

    it("claims nothing, and asks the database nothing, for an empty selection", async () => {
      const tx = { update: jest.fn() };

      const claimed = await service.markEntriesInvoiced(tx as never, ORG, []);

      expect(claimed).toBe(0);
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  /**
   * The reverse of `markEntriesInvoiced` and of `createInvoiceDraft` (the
   * `INVOICE_DRAFTED` write in `lib/billing-export.ts`). This is the fix for
   * the stranded-record bug: `InvoicesLifecycleService.voidInvoice` and the
   * billing "release draft" endpoint both end here, and neither one had a
   * way to get an entry back to `UNINVOICED` before this method existed —
   * `voidEntry` (`entries.service.ts`) refuses to void `INVOICE_DRAFTED` or
   * `INVOICED` directly, so this was the only path back to billable.
   */
  describe("releaseEntriesToUninvoiced", () => {
    it("reports only the rows it actually released, mirroring markEntriesInvoiced's claim-count contract", async () => {
      const returning = jest.fn().mockResolvedValue([{ id: 77 }, { id: 78 }]);
      const where = jest.fn(() => ({ returning }));
      const set = jest.fn(() => ({ where }));
      const tx = { update: jest.fn(() => ({ set })) };

      const released = await service.releaseEntriesToUninvoiced(
        tx as never,
        ORG,
        [77, 78],
      );

      expect(released).toEqual([77, 78]);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ invoicingStatus: "UNINVOICED" }),
      );
    });

    it("writes through the transaction handle it is given, so the release commits atomically with the invoice void that triggered it", async () => {
      const returning = jest.fn().mockResolvedValue([{ id: 77 }]);
      const tx = {
        update: jest.fn(() => ({ set: () => ({ where: () => ({ returning }) }) })),
      };

      await service.releaseEntriesToUninvoiced(tx as never, ORG, [77]);

      expect(tx.update).toHaveBeenCalledTimes(1);
    });

    it("releases nothing, and asks the database nothing, for an empty selection", async () => {
      const tx = { update: jest.fn() };

      const released = await service.releaseEntriesToUninvoiced(tx as never, ORG, []);

      expect(released).toEqual([]);
      expect(tx.update).not.toHaveBeenCalled();
    });
  });
});
