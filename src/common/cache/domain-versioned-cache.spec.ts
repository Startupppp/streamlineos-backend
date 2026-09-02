import { CACHE_KEYS } from "./cache-keys";
import { ExpensesService } from "../../modules/expenses/expenses.service";
import { AssetsService } from "../../modules/finance/assets/assets.service";
import { TaxDashboardService } from "../../modules/finance/tax/tax-dashboard.service";
import { ExpensePoliciesService } from "../../modules/finance/expenses/expense-policies.service";
import { BankAccountsService } from "../../modules/finance/banking/bank-accounts.service";
import { ForecastService } from "../../modules/finance/planning/forecast.service";
import { OverviewService } from "../../modules/finance/reports/overview.service";
import { StatementReportsService } from "../../modules/finance/reports/statement-reports.service";
import { AnalyticsReportsService } from "../../modules/finance/reports/analytics-reports.service";
import { SELF_ONLY_SCOPE } from "../../modules/expenses/expenses-scope";

describe("finance and expense versioned cache contracts", () => {
  const cachedVersioned = jest.fn().mockResolvedValue({ cached: true });
  const cache = { cachedVersioned };

  beforeEach(() => cachedVersioned.mockClear());

  it("tenant-namespaces expense list reads", async () => {
    const service = new ExpensesService({} as never, cache as never, {} as never);
    await service.list("org-1", "user-1", SELF_ONLY_SCOPE, {} as never);

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.expensesListNamespace("org-1"),
      expect.stringContaining("user-1:own"),
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces asset list reads", async () => {
    const service = new AssetsService(
      {} as never,
      {} as never,
      {} as never,
      cache as never,
    );
    await service.list("org-1", { limit: 25 });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finAssetsListNamespace("org-1"),
      ":25::",
      expect.any(Function),
      60,
    );
  });

  it("keys the asset list on the clamped page size, so an over-cap request shares the capped entry", async () => {
    const service = new AssetsService(
      {} as never,
      {} as never,
      {} as never,
      cache as never,
    );
    await service.list("org-1", { limit: 5000 });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finAssetsListNamespace("org-1"),
      ":100::",
      expect.any(Function),
      60,
    );
  });

  it("never writes the string undefined into an asset list cache key", async () => {
    const service = new AssetsService(
      {} as never,
      {} as never,
      {} as never,
      cache as never,
    );
    await service.list("org-1", { limit: 25 });

    const [, key] = cachedVersioned.mock.calls[0] ?? [];
    expect(String(key)).not.toContain("undefined");
  });

  it("tenant-namespaces tax dashboard reads", async () => {
    const service = new TaxDashboardService(
      {} as never,
      cache as never,
      {} as never,
    );
    await service.getDashboard("org-1", {
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finTaxDashboardNamespace("org-1"),
      "2026-01-01:2026-01-31",
      expect.any(Function),
      120,
    );
  });

  it("tenant-namespaces expense-policy reads", async () => {
    const service = new ExpensePoliciesService(
      {} as never,
      cache as never,
      {} as never,
    );
    await service.list("org-1");

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finExpensePoliciesNamespace("org-1"),
      "list",
      expect.any(Function),
      300,
    );
  });

  it("tenant-namespaces bank-account detail reads", async () => {
    const service = new BankAccountsService(
      {} as never,
      {} as never,
      cache as never,
      {} as never,
    );
    await service.findOne("org-1", 42);

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finBankAccountsNamespace("org-1"),
      "42",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces forecast reads", async () => {
    const service = new ForecastService({} as never, cache as never);
    await service.getForecast("org-1", { scenarioId: 7, weeks: 26 });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finForecastNamespace("org-1"),
      "7:26",
      expect.any(Function),
      120,
    );
    expect(CACHE_KEYS.finBvaNamespace("org-1", 9)).toBe("fin:bva:org-1:9");
  });

  it("tenant-namespaces fin overview reads", async () => {
    const service = new OverviewService({} as never, cache as never);
    await service.getOverview("org-1", {});

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finReportsNamespace("org-1"),
      "default",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces fin overview with date range reads", async () => {
    const service = new OverviewService({} as never, cache as never);
    await service.getOverview("org-1", { from: "2026-01-01", to: "2026-01-31" });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finReportsNamespace("org-1"),
      "2026-01-01:2026-01-31",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces vendor statement reads", async () => {
    const service = new StatementReportsService({} as never, cache as never);
    await service.vendorStatement("org-1", 42, "2026-01-01", "2026-01-31");

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finReportsNamespace("org-1"),
      "vendor-stmt:42:2026-01-01:2026-01-31",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces customer statement reads", async () => {
    const service = new StatementReportsService({} as never, cache as never);
    await service.customerStatement("org-1", 7, "2026-01-01", "2026-01-31");

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finReportsNamespace("org-1"),
      "customer-stmt:7:2026-01-01:2026-01-31",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("tenant-namespaces analytics project-profitability reads", async () => {
    const service = new AnalyticsReportsService({} as never, cache as never);
    await service.projectProfitability("org-1", "2026-01-01", "2026-01-31");

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finReportsNamespace("org-1"),
      "proj-profit:2026-01-01:2026-01-31",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("analytics budget-vs-actual reads use finBvaNamespace not finReportsNamespace", async () => {
    const service = new AnalyticsReportsService({} as never, cache as never);
    await service.budgetVsActual("org-1", 5, "2026-01-01", "2026-01-31");

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finBvaNamespace("org-1", 5),
      "2026-01-01:2026-01-31",
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("finReportsNamespace key includes orgId", () => {
    expect(CACHE_KEYS.finReportsNamespace("org-abc")).toBe("fin:reports:org-abc");
  });
});
