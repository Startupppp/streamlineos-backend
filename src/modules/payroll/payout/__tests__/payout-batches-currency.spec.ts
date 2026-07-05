import { describe, it, expect } from "@jest/globals";

function defaultFormatFromCurrency(currency: string): string {
  if (currency === "INR") return "NEFT_CSV";
  if (currency === "USD") return "ACH_CSV";
  if (currency === "EUR") return "SEPA_CSV";
  return "GENERIC_CSV";
}

type EligibleEmployee = {
  id: number;
  userId: string;
  net: string;
  currency: string;
  payoutCurrency: string | null;
  netPayoutCurrency: string | null;
  status: string;
  holdReason: string | null;
  bankDetails: string | null;
  name: string | null;
};

function groupByCurrency(eligible: EligibleEmployee[]): Map<string, EligibleEmployee[]> {
  const map = new Map<string, EligibleEmployee[]>();
  for (const emp of eligible) {
    const code = emp.payoutCurrency ?? emp.currency;
    const arr = map.get(code) ?? [];
    arr.push(emp);
    map.set(code, arr);
  }
  return map;
}

function effectiveAmount(emp: EligibleEmployee): string {
  return emp.netPayoutCurrency ?? emp.net;
}

describe("multi-currency batch grouping", () => {
  it("groups employees by payoutCurrency when set", () => {
    const employees: EligibleEmployee[] = [
      { id: 1, userId: "u1", net: "100000", currency: "INR", payoutCurrency: "INR", netPayoutCurrency: null, status: "PROCESSED", holdReason: null, bankDetails: null, name: "Alice" },
      { id: 2, userId: "u2", net: "120000", currency: "INR", payoutCurrency: "USD", netPayoutCurrency: "1450.00", status: "PROCESSED", holdReason: null, bankDetails: null, name: "Bob" },
      { id: 3, userId: "u3", net: "90000", currency: "INR", payoutCurrency: "EUR", netPayoutCurrency: "980.00", status: "PROCESSED", holdReason: null, bankDetails: null, name: "Carol" },
    ];

    const groups = groupByCurrency(employees);
    expect(groups.size).toBe(3);
    expect(groups.has("INR")).toBe(true);
    expect(groups.has("USD")).toBe(true);
    expect(groups.has("EUR")).toBe(true);
    expect(groups.get("INR")).toHaveLength(1);
    expect(groups.get("USD")).toHaveLength(1);
    expect(groups.get("EUR")).toHaveLength(1);
  });

  it("falls back to currency when payoutCurrency is null", () => {
    const employees: EligibleEmployee[] = [
      { id: 1, userId: "u1", net: "50000", currency: "INR", payoutCurrency: null, netPayoutCurrency: null, status: "PROCESSED", holdReason: null, bankDetails: null, name: "Dave" },
      { id: 2, userId: "u2", net: "60000", currency: "INR", payoutCurrency: null, netPayoutCurrency: null, status: "PROCESSED", holdReason: null, bankDetails: null, name: "Eve" },
    ];

    const groups = groupByCurrency(employees);
    expect(groups.size).toBe(1);
    expect(groups.get("INR")).toHaveLength(2);
  });

  it("uses netPayoutCurrency as the batch amount when set", () => {
    const emp: EligibleEmployee = {
      id: 1, userId: "u1", net: "120000", currency: "INR",
      payoutCurrency: "USD", netPayoutCurrency: "1450.00",
      status: "PROCESSED", holdReason: null, bankDetails: null, name: "Bob",
    };
    expect(effectiveAmount(emp)).toBe("1450.00");
  });

  it("falls back to net when netPayoutCurrency is null", () => {
    const emp: EligibleEmployee = {
      id: 1, userId: "u1", net: "100000", currency: "INR",
      payoutCurrency: null, netPayoutCurrency: null,
      status: "PROCESSED", holdReason: null, bankDetails: null, name: "Alice",
    };
    expect(effectiveAmount(emp)).toBe("100000");
  });

  it("selects NEFT_CSV format for INR group", () => {
    expect(defaultFormatFromCurrency("INR")).toBe("NEFT_CSV");
  });

  it("selects ACH_CSV format for USD group", () => {
    expect(defaultFormatFromCurrency("USD")).toBe("ACH_CSV");
  });

  it("selects SEPA_CSV format for EUR group", () => {
    expect(defaultFormatFromCurrency("EUR")).toBe("SEPA_CSV");
  });

  it("selects GENERIC_CSV format for unknown currency", () => {
    expect(defaultFormatFromCurrency("SGD")).toBe("GENERIC_CSV");
  });

  it("idempotency sub-key is currency-scoped", () => {
    const baseKey = "idem-abc-123";
    const currencies = ["INR", "USD"];
    const subKeys = currencies.map((c) => `${baseKey}-${c}`);
    expect(subKeys).toEqual(["idem-abc-123-INR", "idem-abc-123-USD"]);
    expect(new Set(subKeys).size).toBe(2);
  });
});

describe("eligible employee filtering", () => {
  it("excludes HELD employees", () => {
    const emp: EligibleEmployee = {
      id: 1, userId: "u1", net: "50000", currency: "INR",
      payoutCurrency: null, netPayoutCurrency: null,
      status: "HELD", holdReason: null, bankDetails: null, name: "Frank",
    };
    const isEligible = emp.status !== "HELD" && !emp.holdReason;
    expect(isEligible).toBe(false);
  });

  it("excludes employees with zero net in payout currency", () => {
    const emp: EligibleEmployee = {
      id: 1, userId: "u1", net: "0", currency: "INR",
      payoutCurrency: "USD", netPayoutCurrency: "0.00",
      status: "PROCESSED", holdReason: null, bankDetails: null, name: "Grace",
    };
    const net = parseFloat(emp.netPayoutCurrency ?? emp.net);
    expect(net).toBeLessThanOrEqual(0);
  });
});
