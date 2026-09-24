import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { type Db } from "../../db/drizzle.module";
import { InvoicesService } from "./invoices.service";
import { invoiceDetailResponseSchema } from "./dto/invoice-response.schemas";

const STORED_ITEMS = [
  {
    id: 1,
    description: "Onboarding workshop",
    hsnSacCode: null,
    quantity: "1.0000",
    rate: "12000.0000",
    gstRate: "18.00",
    amount: "12000.0000",
    lineOrder: 0,
    timesheetEntryId: 4211,
  },
  {
    id: 2,
    description: "Implementation retainer",
    hsnSacCode: "998314",
    quantity: "2.0000",
    rate: "45000.5000",
    gstRate: "18.00",
    amount: "90001.0000",
    lineOrder: 1,
    timesheetEntryId: null,
  },
];

const STORED_INVOICE = {
  id: 7,
  orgId: "org-1",
  invoiceNumber: "INV-0007",
  subtotal: "102001.0000",
  total: "120361.1800",
  currency: "INR",
  status: "ISSUED",
  client: null,
  project: null,
  creator: null,
  payments: [],
};

interface FindFirstArgs {
  with?: { items?: { columns?: Record<string, boolean>; orderBy?: unknown } };
}

/**
 * Answers in the shape the driver produces — decimal columns arrive as strings — and records the
 * relation the service asked for, so the assertions below are about the real read path.
 */
function makeDb(row: unknown) {
  const calls: FindFirstArgs[] = [];
  const db = {
    query: {
      invoices: {
        findFirst: jest.fn((args: FindFirstArgs) => {
          calls.push(args);
          return Promise.resolve(row);
        }),
      },
    },
  } as unknown as Db;
  return { db, calls };
}

async function buildService(db: Db): Promise<InvoicesService> {
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: CacheService,
        useValue: { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn() },
      },
    ],
  }).compile();
  return module.get(InvoicesService);
}

describe("GET /invoices/:invoiceId returns the invoice's persisted line items", () => {
  it("carries the stored rows out under lineItems, the name the client reads", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);

    expect(invoice).toBeDefined();
    expect(invoice?.lineItems).toHaveLength(2);
    expect(invoice?.lineItems[0]).toMatchObject({ description: "Onboarding workshop" });
  });

  it("hands the lines on in the order the database returned them, adding no reordering of its own", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: [...STORED_ITEMS].reverse() });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);

    expect(invoice?.lineItems.map((l) => l.lineOrder)).toEqual([1, 0]);
  });

  it("asks the database to order by line order and then id, so the order is total", async () => {
    const { db, calls } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    await service.getInvoice("org-1", 7);

    const orderBy = calls[0].with?.items?.orderBy;
    expect(Array.isArray(orderBy)).toBe(true);
    expect(orderBy as unknown[]).toHaveLength(2);
  });

  it("projects the line columns explicitly rather than selecting the whole row", async () => {
    const { db, calls } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    await service.getInvoice("org-1", 7);

    expect(Object.keys(calls[0].with?.items?.columns ?? {}).sort()).toEqual([
      "amount",
      "description",
      "gstRate",
      "hsnSacCode",
      "id",
      "lineOrder",
      "quantity",
      "rate",
      "timesheetEntryId",
    ]);
  });

  it("projects the billed timesheet entry, so an invoice line can be traced back to the approved time it bills", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);

    expect(invoice?.lineItems[0]?.timesheetEntryId).toBe(4211);
  });

  it("keeps the timesheet link null on a line that bills no time, rather than omitting the field", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);
    const line = invoice?.lineItems[1];

    expect(line).toHaveProperty("timesheetEntryId");
    expect(line?.timesheetEntryId).toBeNull();
  });

  it("declares the timesheet link on the published line-item contract, which otherwise strips it off the wire", () => {
    const parsed = invoiceDetailResponseSchema.shape.lineItems.parse(STORED_ITEMS);

    expect(parsed[0]).toMatchObject({ timesheetEntryId: 4211 });
    expect(parsed[1]).toMatchObject({ timesheetEntryId: null });
  });

  it("keeps every line amount a decimal string, like the invoice's own money fields", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);
    const line = invoice?.lineItems[1];

    expect(typeof line?.quantity).toBe("string");
    expect(typeof line?.rate).toBe("string");
    expect(typeof line?.amount).toBe("string");
    expect(line?.rate).toBe("45000.5000");
    expect(typeof invoice?.total).toBe("string");
  });

  it("returns an empty array, never undefined, for an invoice with no lines", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: [] });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);

    expect(invoice?.lineItems).toEqual([]);
  });

  it("does not leak the raw relation name alongside the contracted one", async () => {
    const { db } = makeDb({ ...STORED_INVOICE, items: STORED_ITEMS });
    const service = await buildService(db);

    const invoice = await service.getInvoice("org-1", 7);

    expect(invoice).not.toHaveProperty("items");
  });

  it("stays a miss for another tenant's invoice id", async () => {
    const { db } = makeDb(undefined);
    const service = await buildService(db);

    await expect(service.getInvoice("org-2", 7)).resolves.toBeUndefined();
  });
});
