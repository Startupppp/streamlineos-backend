/**
 * One invariant across the three settlement paths that post a realized FX gain
 * or loss — an invoice receipt, a bill payment and a payment-run item.
 *
 * Each wrapped its posting in a `catch` that logged at WARN and continued, with
 * a message naming only the "no exchange rate" case. Every other failure — a
 * closed accounting period, an unseeded FX gain/loss account, an idempotency
 * conflict — produced an invoice or bill recorded as fully settled with NO
 * realized gain or loss on the ledger. The P&L was understated and nothing
 * surfaced it.
 *
 * A missing rate is the ONE condition a settlement may absorb: `fin_exchange_rates`
 * is operator-maintained and its absence is not evidence the ledger is wrong.
 * Everything else means the posting that should have happened did not, and must
 * reach the caller.
 *
 * Hermetic: the collaborators are mocks, because what is under test is which
 * exception each catch lets past — not any query.
 */
import { ConflictException } from "@nestjs/common";
import { InvoicesPaymentService } from "../../../invoices/invoices-payment.service";
import { AccountingPayablesService } from "../../../accounting/core/accounting-payables.service";
import { PaymentRunExecutorService } from "../../ap/payment-run-executor.service";
import { ExchangeRateNotFoundError, RateResolverService } from "../rate-resolver.service";
import { FxService } from "../fx.service";
import type { Db } from "../../../../db/drizzle.types";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { JournalPostingService } from "../../../accounting/posting/journal-posting.service";
import type { InvoicesLifecycleService } from "../../../invoices/invoices-lifecycle.service";
import type { AccountingPayablesQueryService } from "../../../accounting/core/accounting-payables-query.service";

/** `select({...}).from(t).where(c).limit(n)` resolving to one settings row. */
function settingsDb(): Db {
  const rows = [{ baseCurrency: "INR" }];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Db;
}

const RATE_MISSING = new ExchangeRateNotFoundError("USD", "INR", "2026-01-31");
/** Stands for every other reason the posting can fail. */
const PERIOD_CLOSED = new ConflictException("Accounting period 2026-01 is closed");

const noopAudit = { log: jest.fn() } as unknown as AuditService;
const noopDispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
const noopPosting = {} as unknown as JournalPostingService;

function rateResolver(): RateResolverService {
  return {
    getRate: jest.fn().mockResolvedValue(83.5),
    getRateString: jest.fn().mockResolvedValue("83.50000000"),
  } as unknown as RateResolverService;
}

function fxThrowing(err: unknown): FxService {
  return { postRealizedGainLoss: jest.fn().mockRejectedValue(err) } as unknown as FxService;
}

function rateResolverThrowing(err: unknown): RateResolverService {
  return {
    getRate: jest.fn().mockRejectedValue(err),
    getRateString: jest.fn().mockRejectedValue(err),
  } as unknown as RateResolverService;
}

const INVOICE = { id: 11, currency: "USD", exchangeRate: "83.50000000" };
const BILL = { id: 22, currency: "USD", exchangeRate: "83.50000000", total: "100.0000" };
const RUN_CAPTURE = {
  billId: 33,
  vendorPaymentId: 44,
  currency: "USD",
  exchangeRate: "83.50000000",
  settledAmount: "100.00",
  userId: "user-1",
};

function arService(rates: RateResolverService, fx: FxService): InvoicesPaymentService {
  return new InvoicesPaymentService(
    settingsDb(),
    noopPosting,
    noopDispatch,
    {} as unknown as InvoicesLifecycleService,
    noopAudit,
    rates,
    fx,
  );
}

function apService(rates: RateResolverService, fx: FxService): AccountingPayablesService {
  return new AccountingPayablesService(
    settingsDb(),
    noopPosting,
    noopAudit,
    {} as unknown as AccountingPayablesQueryService,
    rates,
    fx,
  );
}

function runService(rates: RateResolverService, fx: FxService): PaymentRunExecutorService {
  return new PaymentRunExecutorService(
    settingsDb(),
    noopAudit,
    noopDispatch,
    noopPosting,
    rates,
    fx,
  );
}

const postAr = (svc: InvoicesPaymentService) =>
  svc["postArFxGainLoss"]("org-1", "user-1", INVOICE, 99, "100.00", "2026-01-31");
const postAp = (svc: AccountingPayablesService) =>
  svc["postApFxGainLoss"]("org-1", "user-1", BILL, 99, 100, "2026-01-31");
const postRun = (svc: PaymentRunExecutorService) =>
  svc["postRunItemFxGainLoss"]("org-1", "INR", RUN_CAPTURE, "2026-01-31");

describe("realized FX posting absorbs a missing rate and nothing else", () => {
  describe.each([
    ["invoice receipt", () => postAr(arService(rateResolverThrowing(RATE_MISSING), fxThrowing(PERIOD_CLOSED)))],
    ["bill payment", () => postAp(apService(rateResolverThrowing(RATE_MISSING), fxThrowing(PERIOD_CLOSED)))],
    ["payment-run item", () => postRun(runService(rateResolverThrowing(RATE_MISSING), fxThrowing(PERIOD_CLOSED)))],
  ])("%s", (_name, act) => {
    it("continues when no exchange rate is on file", async () => {
      await expect(act()).resolves.toBeUndefined();
    });
  });

  describe.each([
    ["invoice receipt", () => postAr(arService(rateResolver(), fxThrowing(PERIOD_CLOSED)))],
    ["bill payment", () => postAp(apService(rateResolver(), fxThrowing(PERIOD_CLOSED)))],
    ["payment-run item", () => postRun(runService(rateResolver(), fxThrowing(PERIOD_CLOSED)))],
  ])("%s", (_name, act) => {
    it("propagates a closed period instead of settling with no FX entry", async () => {
      await expect(act()).rejects.toThrow(/closed/i);
    });
  });

  describe.each([
    ["invoice receipt", () => postAr(arService(rateResolverThrowing(PERIOD_CLOSED), fxThrowing(PERIOD_CLOSED)))],
    ["bill payment", () => postAp(apService(rateResolverThrowing(PERIOD_CLOSED), fxThrowing(PERIOD_CLOSED)))],
    ["payment-run item", () => postRun(runService(rateResolverThrowing(PERIOD_CLOSED), fxThrowing(PERIOD_CLOSED)))],
  ])("%s", (_name, act) => {
    it("propagates a rate lookup that failed for any reason other than absence", async () => {
      await expect(act()).rejects.toThrow(/closed/i);
    });
  });
});
