import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { TimesheetInvoicingService } from "../timesheets/core/timesheet-invoicing.service";
import { safestInvoiceLineDetail } from "../timesheets/core/invoice-line-detail";
import { InvoicesPostingService } from "./invoices-posting.service";
import { InvoicesFromTimesheetsService } from "./invoices-from-timesheets.service";
import { invoiceLineDescription } from "./lib/invoice-line-description";
import {
  createInvoiceFromTimesheetsSchema,
  type CreateInvoiceFromTimesheetsInput,
} from "./dto/invoice-write.schemas";

const ORG = "org-inv-detail";
const USER = "user-inv-detail";
const PRIVATE_NOTE = "Client keeps changing their mind, rebuilt the header twice";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    projectId: 10,
    projectName: "Website",
    date: "2026-09-01",
    hours: "4.00",
    billRate: "150.00",
    currency: "INR",
    description: PRIVATE_NOTE,
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

describe("InvoicesFromTimesheetsService line detail", () => {
  let service: InvoicesFromTimesheetsService;
  let loadedEntries: Array<ReturnType<typeof entry>>;
  let projectDetailByProjectId: Map<number, "summary" | "raw">;
  let txValues: jest.Mock;
  let resolveInvoiceLineDetail: jest.Mock;
  let txHandle: unknown;

  const insertedItemRows = () =>
    (txValues.mock.calls[1]?.[0] ?? []) as Array<Record<string, unknown>>;
  const insertedDescriptions = () =>
    insertedItemRows().map((row) => String(row.description));

  beforeEach(async () => {
    loadedEntries = [entry()];
    projectDetailByProjectId = new Map([[10, "summary"]]);

    txValues = jest.fn().mockReturnThis();
    const txInsert = jest.fn().mockReturnValue({
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
        where: jest.fn(() =>
          Object.assign(Promise.resolve([{ count: 0 }]), {
            limit: jest.fn().mockResolvedValue([{ count: 0 }]),
          }),
        ),
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
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ address: null }),
        },
      },
    };

    resolveInvoiceLineDetail = jest
      .fn()
      .mockImplementation(
        (_tx: unknown, _orgId: string, projectIds: Array<number | null>) => {
          if (projectIds.some((id) => id === null))
            return Promise.resolve("summary");
          const resolved = projectIds.map(
            (id) => projectDetailByProjectId.get(id as number) ?? "summary",
          );
          return Promise.resolve(safestInvoiceLineDetail(resolved));
        },
      );

    const module = await Test.createTestingModule({
      providers: [
        InvoicesFromTimesheetsService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: InvoicesPostingService,
          useValue: { postInvoiceIssued: jest.fn().mockResolvedValue(null) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CacheService,
          useValue: {
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TimesheetInvoicingService,
          useValue: {
            loadInvoiceableEntries: jest
              .fn()
              .mockImplementation(() => Promise.resolve(loadedEntries)),
            markEntriesInvoiced: jest
              .fn()
              .mockImplementation((_tx: unknown, _orgId: string, ids: number[]) =>
                Promise.resolve(ids.length),
              ),
            resolveInvoiceLineDetail,
          },
        },
      ],
    }).compile();

    service = module.get(InvoicesFromTimesheetsService);
  });

  it("keeps the worker's own timesheet note out of a summary project's invoice line, which the client portal publishes verbatim", async () => {
    projectDetailByProjectId = new Map([[10, "summary"]]);

    await service.createFromTimesheets(ORG, USER, input());

    expect(insertedDescriptions()[0]).not.toContain(PRIVATE_NOTE);
    expect(insertedDescriptions()[0]).toBe("Website · 2026-09-01 · 4.00 h billed");
  });

  it("carries the timesheet note onto a raw project's invoice line, which is the whole point of opting in", async () => {
    projectDetailByProjectId = new Map([[10, "raw"]]);

    await service.createFromTimesheets(ORG, USER, input());

    expect(insertedDescriptions()[0]).toContain(PRIVATE_NOTE);
  });

  it("bills a project that never touched the setting as summary, because the resolver answers summary for an untouched column", async () => {
    projectDetailByProjectId = new Map();

    await service.createFromTimesheets(ORG, USER, input());

    expect(insertedDescriptions()[0]).not.toContain(PRIVATE_NOTE);
  });

  it("lets the safe value win when the selection spans a raw project and a summary one", async () => {
    loadedEntries = [
      entry({ id: 77, projectId: 10, projectName: "Website" }),
      entry({ id: 78, projectId: 11, projectName: "Intranet" }),
    ];
    projectDetailByProjectId = new Map([
      [10, "raw"],
      [11, "summary"],
    ]);

    await service.createFromTimesheets(
      ORG,
      USER,
      input({ timesheetEntryIds: [77, 78] }),
    );

    expect(insertedDescriptions()).toHaveLength(2);
    for (const description of insertedDescriptions())
      expect(description).not.toContain(PRIVATE_NOTE);
  });

  it("resolves the setting through the transaction that inserts the invoice, so the value cannot change between the read and the write", async () => {
    await service.createFromTimesheets(ORG, USER, input());

    expect(resolveInvoiceLineDetail).toHaveBeenCalledWith(txHandle, ORG, [10]);
  });

  it("resolves the setting once for the whole selection rather than once per line", async () => {
    loadedEntries = [
      entry({ id: 77, projectId: 10 }),
      entry({ id: 78, projectId: 10 }),
      entry({ id: 79, projectId: 11 }),
    ];
    projectDetailByProjectId = new Map([
      [10, "raw"],
      [11, "raw"],
    ]);

    await service.createFromTimesheets(
      ORG,
      USER,
      input({ timesheetEntryIds: [77, 78, 79] }),
    );

    expect(resolveInvoiceLineDetail).toHaveBeenCalledTimes(1);
    expect(insertedItemRows()).toHaveLength(3);
  });

  it("prices a summary line exactly as it prices a raw one, because the setting governs wording and never money", async () => {
    projectDetailByProjectId = new Map([[10, "summary"]]);
    await service.createFromTimesheets(ORG, USER, input());
    const summaryRow = insertedItemRows()[0];

    txValues.mockClear();
    projectDetailByProjectId = new Map([[10, "raw"]]);
    await service.createFromTimesheets(ORG, USER, input());
    const rawRow = insertedItemRows()[0];

    expect(summaryRow?.amount).toBe(rawRow?.amount);
    expect(summaryRow?.quantity).toBe(rawRow?.quantity);
    expect(summaryRow?.rate).toBe(rawRow?.rate);
  });

  describe("invoiceLineDescription", () => {
    it("names only facts the customer is already entitled to see when the project is on summary", () => {
      const line = invoiceLineDescription(entry(), "summary");

      expect(line).not.toContain(PRIVATE_NOTE);
      expect(line).toContain("Website");
      expect(line).toContain("2026-09-01");
      expect(line).toContain("4.00");
    });

    it("omits the note from a raw line that has none, rather than trailing an empty separator", () => {
      expect(invoiceLineDescription(entry({ description: null }), "raw")).toBe(
        "Website · 2026-09-01",
      );
    });

    it("falls back to a neutral label when the time is not attached to a project", () => {
      expect(
        invoiceLineDescription(entry({ projectName: null }), "summary"),
      ).toBe("Time · 2026-09-01 · 4.00 h billed");
    });
  });
});
