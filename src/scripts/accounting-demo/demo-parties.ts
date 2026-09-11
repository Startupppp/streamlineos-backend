/** The demo's customers and vendors, resolved by external ref so a re-run finds them. */
import { KARNATAKA, MAHARASHTRA, type Context } from "./demo-context";

interface PartySeed {
  key: string;
  displayName: string;
  role: "customer" | "vendor";
  countryCode: string;
  currency: string;
  region: string | null;
  gstin: string | null;
  withholdingCode?: string;
  paymentTermsDays: number;
}

const PARTIES: readonly PartySeed[] = [
  {
    key: "customer-bengaluru",
    displayName: "Bengaluru Systems Pvt Ltd",
    role: "customer",
    countryCode: "IN",
    currency: "INR",
    region: KARNATAKA,
    gstin: "29AAACX1234C1ZP",
    paymentTermsDays: 30,
  },
  {
    key: "customer-mumbai",
    displayName: "Mumbai Traders LLP",
    role: "customer",
    countryCode: "IN",
    currency: "INR",
    region: MAHARASHTRA,
    gstin: "27AAACX5678C1ZP",
    paymentTermsDays: 15,
  },
  {
    key: "customer-northwind",
    displayName: "Northwind Analytics Inc",
    role: "customer",
    countryCode: "US",
    currency: "USD",
    region: null,
    gstin: null,
    paymentTermsDays: 45,
  },
  {
    key: "vendor-supplies",
    displayName: "Karnataka Office Supplies",
    role: "vendor",
    countryCode: "IN",
    currency: "INR",
    region: KARNATAKA,
    gstin: "29AAACY1111C1ZP",
    paymentTermsDays: 30,
  },
  {
    key: "vendor-consulting",
    displayName: "Meridian Consulting LLP",
    role: "vendor",
    countryCode: "IN",
    currency: "INR",
    region: KARNATAKA,
    gstin: "29AAACY2222C1ZP",
    withholdingCode: "194J",
    paymentTermsDays: 15,
  },
];

export async function seedParties(ctx: Context): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();

  for (const seed of PARTIES) {
    // The external ref is the identity, so a second run resolves rather than
    // creating a twin.
    const party = await ctx.parties.resolveOrCreateByExternalRef(
      ctx.orgId,
      ctx.bookId,
      { system: "accounting-demo-seed", id: seed.key },
      {
        role: seed.role,
        displayName: seed.displayName,
        countryCode: seed.countryCode,
        defaultCurrency: seed.currency,
        billingCountryCode: seed.countryCode,
        billingRegion: seed.region,
        paymentTermsDays: seed.paymentTermsDays,
        withholdingCode: seed.withholdingCode ?? null,
      },
      ctx.userId,
    );
    byKey.set(seed.key, party.id);

    if (seed.gstin) {
      const existing = await ctx.parties.listRegistrations(ctx.orgId, party.id);
      if (!existing.some((r) => r.number === seed.gstin)) {
        await ctx.parties.addRegistration(ctx.orgId, party.id, {
          regime: "GST_IN",
          number: seed.gstin,
          countryCode: "IN",
        });
      }
    }
  }

  return byKey;
}
