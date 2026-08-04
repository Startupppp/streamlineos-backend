import { CACHE_KEYS } from "./cache-keys";
import { ExpensesService } from "../../modules/expenses/expenses.service";
import { AssetsService } from "../../modules/finance/assets/assets.service";
import { TaxDashboardService } from "../../modules/finance/tax/tax-dashboard.service";
import { ExpensePoliciesService } from "../../modules/finance/expenses/expense-policies.service";
import { BankAccountsService } from "../../modules/finance/banking/bank-accounts.service";
import { ForecastService } from "../../modules/finance/planning/forecast.service";

describe("finance and expense versioned cache contracts", () => {
  const cachedVersioned = jest.fn().mockResolvedValue({ cached: true });
  const cache = { cachedVersioned };

  beforeEach(() => cachedVersioned.mockClear());

  it("tenant-namespaces expense list reads", async () => {
    const service = new ExpensesService({} as never, cache as never, {} as never);
    await service.list("org-1", "user-1", false, {});

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.expensesListNamespace("org-1"),
      expect.stringContaining("user-1:self"),
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
    await service.list("org-1", { page: 1, pageSize: 25 });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.finAssetsListNamespace("org-1"),
      "1:25::",
      expect.any(Function),
      60,
    );
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
});
