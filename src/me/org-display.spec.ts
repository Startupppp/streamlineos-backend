import type { Db } from "../db/drizzle.types";
import {
  DEFAULT_ORG_DISPLAY,
  localeForCurrency,
  normaliseCurrency,
  orgDisplayFor,
  readOrgDisplay,
} from "./org-display";

function dbReturning(rows: Record<string, unknown>[]): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Db;
}

describe("normaliseCurrency", () => {
  it("accepts a well-formed code in any case", () => {
    expect(normaliseCurrency("usd")).toBe("USD");
    expect(normaliseCurrency(" GBP ")).toBe("GBP");
  });

  it("falls back rather than handing Intl a value that throws", () => {
    // `new Intl.NumberFormat(l, { currency: "" })` is a RangeError, which would
    // take down every money cell on the page rather than one figure.
    for (const bad of ["", "  ", "RUPEES", "US", "12", null, undefined])
      expect(normaliseCurrency(bad)).toBe(DEFAULT_ORG_DISPLAY.currency);
  });
});

describe("localeForCurrency", () => {
  it("keeps rupees grouped in lakhs whoever is reading", () => {
    expect(localeForCurrency("INR")).toBe("en-IN");
  });

  it("falls back to a locale Intl certainly has for an unmapped currency", () => {
    expect(localeForCurrency("NGN")).toBe("en-US");
  });

  it("produces a locale every mapped currency can actually format with", () => {
    const codes = ["INR", "USD", "GBP", "EUR", "AED", "SGD", "AUD", "CAD", "JPY", "CHF", "ZAR"];
    for (const currency of codes) {
      const { locale } = orgDisplayFor(currency);
      expect(() =>
        new Intl.NumberFormat(locale, { style: "currency", currency }).format(1234.5),
      ).not.toThrow();
    }
  });
});

describe("readOrgDisplay", () => {
  it("reads the organisation's own currency", async () => {
    expect(await readOrgDisplay(dbReturning([{ currency: "AED" }]), "org-1")).toEqual({
      currency: "AED",
      locale: "en-AE",
    });
  });

  it("falls back for an organisation that no longer exists", async () => {
    expect(await readOrgDisplay(dbReturning([]), "org-gone")).toEqual(DEFAULT_ORG_DISPLAY);
  });

  it("refuses to query without an organisation", async () => {
    let queried = false;
    const db = {
      select: () => {
        queried = true;
        return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
      },
    } as unknown as Db;

    expect(await readOrgDisplay(db, "")).toEqual(DEFAULT_ORG_DISPLAY);
    expect(queried).toBe(false);
  });

  it("survives a currency the column should never have held", async () => {
    expect(await readOrgDisplay(dbReturning([{ currency: "rupees" }]), "org-1")).toEqual(
      DEFAULT_ORG_DISPLAY,
    );
  });
});
