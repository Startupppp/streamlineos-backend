import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { TimesheetInvoicingService } from "./timesheet-invoicing.service";
import { safestInvoiceLineDetail } from "./invoice-line-detail";

const ORG = "org-ts-detail";

describe("TimesheetInvoicingService.resolveInvoiceLineDetail", () => {
  let service: TimesheetInvoicingService;
  let projectRows: Array<{ invoiceLineDetail: "summary" | "raw" }>;
  let txSelect: jest.Mock;
  let tx: { select: jest.Mock };

  beforeEach(async () => {
    projectRows = [];
    txSelect = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(projectRows)) })),
      })),
    }));
    tx = { select: txSelect };

    const module = await Test.createTestingModule({
      providers: [
        TimesheetInvoicingService,
        { provide: DRIZZLE, useValue: { select: jest.fn() } },
      ],
    }).compile();

    service = module.get(TimesheetInvoicingService);
  });

  it("answers summary for a project that never touched the setting, because the column defaults to summary and that default is what the read returns", async () => {
    projectRows = [{ invoiceLineDetail: "summary" }];

    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, [10]),
    ).resolves.toBe("summary");
  });

  it("answers raw only when every project in the selection asked for raw", async () => {
    projectRows = [{ invoiceLineDetail: "raw" }, { invoiceLineDetail: "raw" }];

    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, [10, 11]),
    ).resolves.toBe("raw");
  });

  it("lets the safe value win a selection spanning two projects that disagree, so one project's opt-in cannot publish another project's notes", async () => {
    projectRows = [{ invoiceLineDetail: "raw" }, { invoiceLineDetail: "summary" }];

    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, [10, 11]),
    ).resolves.toBe("summary");
  });

  it("reads the setting once for the whole selection rather than once per line", async () => {
    projectRows = [{ invoiceLineDetail: "raw" }, { invoiceLineDetail: "raw" }];

    await service.resolveInvoiceLineDetail(tx as never, ORG, [10, 11, 10, 11, 10]);

    expect(txSelect).toHaveBeenCalledTimes(1);
  });

  it("answers the safe value for time with no project, and asks the database nothing, because there is no project setting to read", async () => {
    projectRows = [{ invoiceLineDetail: "raw" }];

    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, [10, null]),
    ).resolves.toBe("summary");
    expect(txSelect).not.toHaveBeenCalled();
  });

  it("answers the safe value when a selected project id resolves to no readable row, rather than falling through to raw on a short read", async () => {
    projectRows = [{ invoiceLineDetail: "raw" }];

    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, [10, 11]),
    ).resolves.toBe("summary");
  });

  it("asks the database nothing for an empty selection and still answers the safe value", async () => {
    await expect(
      service.resolveInvoiceLineDetail(tx as never, ORG, []),
    ).resolves.toBe("summary");
    expect(txSelect).not.toHaveBeenCalled();
  });

  describe("safestInvoiceLineDetail", () => {
    it("treats an empty set as safe rather than as unanimous consent to raw", () => {
      expect(safestInvoiceLineDetail([])).toBe("summary");
    });

    it("returns raw for a unanimous raw set, which is the positive half the negatives above would otherwise pass without", () => {
      expect(safestInvoiceLineDetail(["raw", "raw"])).toBe("raw");
      expect(safestInvoiceLineDetail(["raw", "summary"])).toBe("summary");
    });
  });
});
