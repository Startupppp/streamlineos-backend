import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { LedgerRejection } from "../kernel/ledger.types";
import { AdapterRejection } from "./posting-command.types";

/**
 * ACC-06: what a caller actually receives when accounting refuses a posting.
 *
 * Both refusals used to come back as
 * `500 {"code":"INTERNAL_ERROR","message":"An unexpected error occurred"}`.
 *
 * `AdapterRejection` — the missing account mapping, the whole subject of ACC-06
 * — had no filter at all. `LedgerRejection` had one and it **never fired**:
 * Nest tries global filters in reverse registration order, `APP_FILTER`
 * providers are registered during module init, and `main.ts` calls
 * `useGlobalFilters(new AllExceptionsFilter())` after that, so the catch-all was
 * always last and always won. Measured by booting a Nest app with the filter
 * registered exactly as the application did: 500. Registering it *after* the
 * catch-all instead gave 409, which is what confirmed the ordering.
 *
 * So every locked period, header-account posting and unbalanced journal across
 * AR, AP, banking, the kernel and the inventory bridge answered 500, was logged
 * as an unhandled exception, and paged somebody. Both classes now carry their
 * own status, which no filter ordering can undo.
 *
 * This boots a real app and registers the catch-all exactly as `main.ts` does,
 * because the defect was never in a mapping function — it was in which code got
 * to run. A unit test of a filter would have stayed green throughout.
 */

@Controller("refusals")
class RefusingController {
  @Get("missing-tag")
  missingTag(): never {
    throw new AdapterRejection(
      "UNKNOWN_ACCOUNT_TAG",
      'No account is tagged "inventory" in this book. Re-run the chart of accounts setup.',
      { tags: ["inventory"] },
    );
  }

  @Get("unbalanced")
  unbalanced(): never {
    throw new AdapterRejection(
      "UNBALANCED_COMMAND",
      "payroll_run r-1 does not balance: debits 500000, credits 498800, difference 1200",
      { debit: 500000, credit: 498800 },
    );
  }

  @Get("not-enabled")
  notEnabled(): never {
    throw new AdapterRejection("BOOK_NOT_ENABLED", "Accounting is not enabled for org-1");
  }

  @Get("locked-period")
  lockedPeriod(): never {
    throw new LedgerRejection("PERIOD_LOCKED", "Period Sep 2026 is locked and cannot accept postings");
  }

  @Get("missing-account")
  missingAccount(): never {
    throw new LedgerRejection("ACCOUNT_NOT_FOUND", "No such account in this book", 2);
  }

  @Get("genuine-fault")
  genuineFault(): never {
    throw new Error("a real server fault");
  }
}

@Module({ controllers: [RefusingController] })
class TestModule {}

describe("accounting refusals over HTTP", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    // Exactly what `main.ts` does, so the ordering under test is the real one.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(`/refusals/${path}`);

  it("answers a missing account role with 409 and something to act on", async () => {
    const res = await get("missing-tag");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNKNOWN_ACCOUNT_TAG");
    /* An operator has to be able to fix this without reading a server log. */
    expect(res.body.message).toContain("chart of accounts setup");
    expect(res.body.details).toEqual({ tags: ["inventory"] });
  });

  it("no longer answers a chart-of-accounts problem with INTERNAL_ERROR", async () => {
    const res = await get("missing-tag");
    expect(res.status).not.toBe(500);
    expect(res.body.code).not.toBe("INTERNAL_ERROR");
  });

  it("answers a locked period with 409, which it never did before", async () => {
    const res = await get("locked-period");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PERIOD_LOCKED");
    expect(res.body.message).toContain("Sep 2026");
  });

  it("keeps a missing account a 404, not a 403 that confirms it exists", async () => {
    const res = await get("missing-account");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("keeps an unbalanced command a 500, because it is a defect and not a setting", async () => {
    /*
      Deliberately not dressed as a 409. It means the sending module's own totals
      do not add up; making it look actionable would quietly stop it being
      investigated. `PostingCommandService` reports it to the tracker at the
      throw site for the same reason.
    */
    const res = await get("unbalanced");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("UNBALANCED_COMMAND");
    /* Legible, unlike the generic envelope it used to get. */
    expect(res.body.message).toContain("difference 1200");
  });

  it("answers BOOK_NOT_ENABLED with 409 if a caller ever forgets to swallow it", async () => {
    const res = await get("not-enabled");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_NOT_ENABLED");
  });

  it("still leaves a genuine fault to the catch-all", async () => {
    /*
      Anti-vacuity for the whole file. If these classes had somehow become
      catch-alls themselves, every assertion above would be about the wrong
      mechanism and this is the one that would notice.
    */
    const res = await get("genuine-fault");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(res.body.message).toBe("An unexpected error occurred");
  });
});
