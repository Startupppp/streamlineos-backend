import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { TimesheetInvoicingService } from "../timesheets/core/timesheet-invoicing.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import { InvoicesFromTimesheetsService } from "./invoices-from-timesheets.service";
import {
  createInvoiceFromTimesheetsSchema,
  type CreateInvoiceFromTimesheetsInput,
} from "./dto/invoice-write.schemas";
import { InvoicesWriteController } from "./invoices-write.controller";
import { REQUIRE_PERMISSION } from "../../common/rbac/require-permission-key";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { VALIDATION_SCHEMAS } from "../../common/validation/validate.decorator";

const ORG = "org-inv-1";
const USER = "user-inv-1";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    projectId: 10,
    projectName: "Website",
    date: "2026-09-01",
    hours: "4.00",
    billRate: "150.00",
    currency: "INR",
    description: "Design pass",
    ...overrides,
  };
}

function input(
  overrides: Partial<CreateInvoiceFromTimesheetsInput> = {},
): CreateInvoiceFromTimesheetsInput {
  return createInvoiceFromTimesheetsSchema.parse({
    timesheetEntryIds: [77],
    ...overrides,
  });
}

describe("InvoicesFromTimesheetsService", () => {
  let service: InvoicesFromTimesheetsService;
  let loadedEntries: Array<ReturnType<typeof entry>>;
  let claimedCount: number | null;
  let txInsert: jest.Mock;
  let txValues: jest.Mock;
  let markEntriesInvoiced: jest.Mock;
  let mockCache: { invalidateNamespaceForOrg: jest.Mock };
  let mockAudit: { log: jest.Mock };
  let mockPosting: { postInvoiceIssued: jest.Mock };
  let txHandle: unknown;

  const insertedInvoiceRow = () =>
    (txValues.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
  const insertedItemRows = () =>
    (txValues.mock.calls[1]?.[0] ?? []) as Array<Record<string, unknown>>;

  beforeEach(async () => {
    loadedEntries = [entry()];
    claimedCount = null;

    txValues = jest.fn().mockReturnThis();
    txInsert = jest.fn().mockReturnValue({
      values: txValues,
      returning: jest.fn().mockResolvedValue([
        {
          id: 1,
          orgId: ORG,
          invoiceNumber: "INV-2026-0001",
          currency: "INR",
          createdAt: new Date("2026-09-23T00:00:00Z"),
        },
      ]),
    });

    const txChain = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ count: 0 }]),
      }),
      insert: txInsert,
    };
    txHandle = txChain;

    const mockDb = {
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(txChain),
        ),
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue({ address: null }) },
      },
    };

    markEntriesInvoiced = jest
      .fn()
      .mockImplementation((_tx: unknown, _orgId: string, ids: number[]) =>
        Promise.resolve(claimedCount ?? ids.length),
      );

    mockCache = { invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined) };
    mockAudit = { log: jest.fn() };
    mockPosting = { postInvoiceIssued: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesFromTimesheetsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: InvoicesPostingService, useValue: mockPosting },
        { provide: AuditService, useValue: mockAudit },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CacheService, useValue: mockCache },
        {
          provide: TimesheetInvoicingService,
          useValue: {
            loadInvoiceableEntries: jest
              .fn()
              .mockImplementation(() => Promise.resolve(loadedEntries)),
            markEntriesInvoiced,
            resolveInvoiceLineDetail: jest.fn().mockResolvedValue("summary"),
          },
        },
      ],
    }).compile();

    service = module.get(InvoicesFromTimesheetsService);
  });

  describe("the hop from approved time to an invoice", () => {
    it("prices each line from the entry's own hours and bill rate, so nothing is re-keyed", async () => {
      loadedEntries = [entry({ id: 77, hours: "4.00", billRate: "150.00" })];

      await service.createFromTimesheets(ORG, USER, input());

      expect(insertedItemRows()[0]).toMatchObject({
        quantity: "4.0000",
        rate: "150.0000",
        amount: "600.0000",
      });
      expect(insertedInvoiceRow()).toMatchObject({
        subtotal: "600.00",
        total: "600.00",
      });
    });

    it("persists the provenance link on every line, which is the only path from an invoice back to the hour it bills", async () => {
      loadedEntries = [entry({ id: 77 }), entry({ id: 78 })];

      await service.createFromTimesheets(
        ORG,
        USER,
        input({ timesheetEntryIds: [77, 78] }),
      );

      expect(insertedItemRows().map((row) => row.timesheetEntryId)).toEqual([
        77, 78,
      ]);
    });

    it("carries the project forward from the selected time rather than asking for it again", async () => {
      loadedEntries = [entry({ id: 77, projectId: 10 }), entry({ id: 78, projectId: 10 })];

      await service.createFromTimesheets(
        ORG,
        USER,
        input({ timesheetEntryIds: [77, 78] }),
      );

      expect(insertedInvoiceRow()).toMatchObject({ projectId: 10 });
    });

    it("leaves the project unset when the selection spans more than one, rather than guessing one of them", async () => {
      loadedEntries = [entry({ id: 77, projectId: 10 }), entry({ id: 78, projectId: 11 })];

      await service.createFromTimesheets(
        ORG,
        USER,
        input({ timesheetEntryIds: [77, 78] }),
      );

      expect(insertedInvoiceRow().projectId).toBeUndefined();
    });

    it("carries the currency forward from the time it bills", async () => {
      loadedEntries = [entry({ currency: "USD" })];

      await service.createFromTimesheets(ORG, USER, input());

      expect(insertedInvoiceRow()).toMatchObject({ currency: "USD" });
    });

    it("refuses a selection billed in two currencies rather than summing them into one number", async () => {
      loadedEntries = [entry({ id: 77, currency: "INR" }), entry({ id: 78, currency: "USD" })];

      await expect(
        service.createFromTimesheets(
          ORG,
          USER,
          input({ timesheetEntryIds: [77, 78] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txInsert).not.toHaveBeenCalled();
    });

    it("refuses a requested project none of the selected time belongs to", async () => {
      loadedEntries = [entry({ projectId: 10 })];

      await expect(
        service.createFromTimesheets(ORG, USER, input({ projectId: 99 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txInsert).not.toHaveBeenCalled();
    });

    it("refuses a discount larger than the invoice it discounts", async () => {
      loadedEntries = [entry({ hours: "1.00", billRate: "100.00" })];

      await expect(
        service.createFromTimesheets(ORG, USER, input({ discount: 500 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txInsert).not.toHaveBeenCalled();
    });
  });

  describe("the invoice and the entry flip are one transaction", () => {
    it("marks the entries invoiced through the very transaction handle that inserted the invoice", async () => {
      await service.createFromTimesheets(ORG, USER, input());

      expect(markEntriesInvoiced).toHaveBeenCalledWith(txHandle, ORG, [77]);
    });

    it("inserts the invoice before it claims the entries, so a failed claim aborts a transaction that has already written", async () => {
      await service.createFromTimesheets(ORG, USER, input());

      expect(txInsert).toHaveBeenCalled();
      expect(txInsert.mock.invocationCallOrder[0]).toBeLessThan(
        markEntriesInvoiced.mock.invocationCallOrder[0],
      );
    });

    it("aborts the whole transaction when another request claimed some of the same entries first", async () => {
      loadedEntries = [entry({ id: 77 }), entry({ id: 78 })];
      claimedCount = 1;

      await expect(
        service.createFromTimesheets(
          ORG,
          USER,
          input({ timesheetEntryIds: [77, 78] }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("neither invalidates a cache nor writes an audit row when the claim failed, because no invoice survived", async () => {
      claimedCount = 0;

      await expect(
        service.createFromTimesheets(ORG, USER, input()),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mockCache.invalidateNamespaceForOrg).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("bumps invoices:list and records the billed entry ids only after the transaction returns", async () => {
      await service.createFromTimesheets(ORG, USER, input());

      expect(mockCache.invalidateNamespaceForOrg).toHaveBeenCalledWith(
        ORG,
        "invoices:list",
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "accounting.invoice.created_from_timesheets",
          metadata: expect.objectContaining({ timesheetEntryIds: [77] }),
        }),
      );
    });

    it("posts to the ledger with the same transaction when the invoice is issued, and not at all when it is a draft", async () => {
      await service.createFromTimesheets(ORG, USER, input({ status: "ISSUED" }));
      expect(mockPosting.postInvoiceIssued).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ invoiceId: 1 }),
        txHandle,
      );

      mockPosting.postInvoiceIssued.mockClear();
      await service.createFromTimesheets(ORG, USER, input({ status: "DRAFT" }));
      expect(mockPosting.postInvoiceIssued).not.toHaveBeenCalled();
    });
  });

  describe("the boundary schema", () => {
    it("requires at least one entry, because an invoice generated from nothing bills nothing", () => {
      expect(
        createInvoiceFromTimesheetsSchema.safeParse({ timesheetEntryIds: [] })
          .success,
      ).toBe(false);
    });

    it("caps the selection so one request cannot walk the whole table", () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      expect(
        createInvoiceFromTimesheetsSchema.safeParse({ timesheetEntryIds: ids })
          .success,
      ).toBe(false);
    });

    it("rejects an unknown key rather than stripping it, so a typo is not silently ignored", () => {
      expect(
        createInvoiceFromTimesheetsSchema.safeParse({
          timesheetEntryIds: [1],
          clientid: 4,
        }).success,
      ).toBe(false);
    });

    it("rejects a gst rate outside the statutory slabs", () => {
      expect(
        createInvoiceFromTimesheetsSchema.safeParse({
          timesheetEntryIds: [1],
          gstRate: 7,
        }).success,
      ).toBe(false);
      expect(
        createInvoiceFromTimesheetsSchema.safeParse({
          timesheetEntryIds: [1],
          gstRate: 18,
        }).success,
      ).toBe(true);
    });
  });

  describe("the route", () => {
    const handler = InvoicesWriteController.prototype.createFromTimesheets;

    it("is gated on a permission key that already exists in both catalogs", () => {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(
        "accounting:create",
      );
    });

    it("is replay-fenced, because billing the same hours twice is the defect this route exists to prevent", () => {
      expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe(
        "accounting.invoice.createFromTimesheets",
      );
    });

    it("parses its body through the strict boundary schema rather than trusting the client", () => {
      expect(Reflect.getMetadata(VALIDATION_SCHEMAS, handler)).toEqual({
        body: createInvoiceFromTimesheetsSchema,
      });
    });
  });
});
