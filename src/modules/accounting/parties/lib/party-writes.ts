import { glParties, type TaxRegime } from "../../../../db/schema";
import type { CreatePartyInput, UpdatePartyInput } from "../dto/parties.schemas";
import type { ExternalRef } from "../parties.types";

/**
 * What a party is written with. These are pure; the statements run in
 * `PartiesService`, on the reader or transaction it holds.
 */

export function partyInsertValues(
  orgId: string,
  bookId: string,
  userId: string | null,
  input: CreatePartyInput,
): typeof glParties.$inferInsert {
  return {
    orgId,
    bookId,
    role: input.role ?? "customer",
    displayName: input.displayName,
    legalName: input.legalName ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    countryCode: input.countryCode.toUpperCase(),
    defaultCurrency: input.defaultCurrency.toUpperCase(),
    billingLine1: input.billingLine1 ?? null,
    billingLine2: input.billingLine2 ?? null,
    billingCity: input.billingCity ?? null,
    billingRegion: input.billingRegion ?? null,
    billingPostalCode: input.billingPostalCode ?? null,
    billingCountryCode: input.billingCountryCode ?? input.countryCode.toUpperCase(),
    shippingLine1: input.shippingLine1 ?? null,
    shippingCity: input.shippingCity ?? null,
    shippingRegion: input.shippingRegion ?? null,
    shippingPostalCode: input.shippingPostalCode ?? null,
    shippingCountryCode: input.shippingCountryCode ?? null,
    externalRefs: input.externalRefs ?? [],
    defaultIncomeAccountId: input.defaultIncomeAccountId ?? null,
    defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
    paymentTermsDays: input.paymentTermsDays ?? 30,
    withholdingCode: input.withholdingCode ?? null,
    notes: input.notes ?? null,
    isActive: input.isActive ?? true,
    createdBy: userId,
  };
}

/** The columns a patch carries a value for; every other column is left alone. */
export function partyPatch(patch: UpdatePartyInput): Partial<typeof glParties.$inferInsert> {
  const values: Partial<typeof glParties.$inferInsert> = {};
  const assign = <K extends keyof typeof glParties.$inferInsert>(
    key: K,
    value: (typeof glParties.$inferInsert)[K] | undefined,
  ) => {
    if (value !== undefined) values[key] = value;
  };

  assign("role", patch.role);
  assign("displayName", patch.displayName);
  assign("legalName", patch.legalName ?? undefined);
  assign("email", patch.email ?? undefined);
  assign("phone", patch.phone ?? undefined);
  assign("countryCode", patch.countryCode?.toUpperCase());
  assign("defaultCurrency", patch.defaultCurrency?.toUpperCase());
  assign("billingLine1", patch.billingLine1 ?? undefined);
  assign("billingLine2", patch.billingLine2 ?? undefined);
  assign("billingCity", patch.billingCity ?? undefined);
  assign("billingRegion", patch.billingRegion ?? undefined);
  assign("billingPostalCode", patch.billingPostalCode ?? undefined);
  assign("billingCountryCode", patch.billingCountryCode ?? undefined);
  assign("shippingLine1", patch.shippingLine1 ?? undefined);
  assign("shippingCity", patch.shippingCity ?? undefined);
  assign("shippingRegion", patch.shippingRegion ?? undefined);
  assign("shippingPostalCode", patch.shippingPostalCode ?? undefined);
  assign("shippingCountryCode", patch.shippingCountryCode ?? undefined);
  assign("defaultIncomeAccountId", patch.defaultIncomeAccountId ?? undefined);
  assign("defaultExpenseAccountId", patch.defaultExpenseAccountId ?? undefined);
  assign("paymentTermsDays", patch.paymentTermsDays);
  assign("withholdingCode", patch.withholdingCode ?? undefined);
  assign("notes", patch.notes ?? undefined);
  assign("isActive", patch.isActive);
  assign("externalRefs", patch.externalRefs);

  return values;
}

export function mergeRefs(refs: readonly ExternalRef[], ref: ExternalRef): ExternalRef[] {
  return refs.some((r) => r.system === ref.system && r.id === ref.id)
    ? [...refs]
    : [...refs, { system: ref.system, id: ref.id }];
}

export function regionFromNumber(regime: TaxRegime, number: string): string | null {
  if (regime !== "GST_IN") return null;
  return /^\d{2}/.test(number) ? number.slice(0, 2) : null;
}
