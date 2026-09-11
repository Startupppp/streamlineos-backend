import { applyBasisPoints, extractInclusiveTax, money } from "../../kernel/money";
import {
  emptyResult,
  taxError,
  type TaxComponentResult,
  type TaxContext,
  type TaxEngine,
  type TaxLineResult,
  type TaxRateTable,
  type TaxResult,
  type SeedTaxCode,
} from "../tax.types";

/**
 * India GST — pack `IN`.
 *
 * This implements the engine interface; it does **not** own invoices. AR and AP
 * call `determine` without knowing India exists.
 *
 * Law note: grounded in 2025–2026 common practice. Rates live in dated rows
 * (`tax_rates`), never as constants here, because the 56th Council's
 * rationalisation moved the slabs and will again. **Verify against
 * gst.gov.in / CBIC before relying on the seeded rates.**
 */

/** First two characters of a GSTIN are the state code. */
export function stateFromGstin(gstin: string): string | null {
  const trimmed = gstin.trim();
  return /^\d{2}/.test(trimmed) ? trimmed.slice(0, 2) : null;
}

/**
 * Union territories take UTGST in place of SGST. Codes per the GST state-code
 * list; Delhi (07), Puducherry (34) and J&K (01) have legislatures and levy
 * SGST, so they are deliberately absent.
 */
const UNION_TERRITORY_CODES = new Set(["04", "25", "26", "31", "35", "38"]);

export class InGstEngine implements TaxEngine {
  readonly pack = "IN";
  readonly status = "enabled" as const;

  determine(context: TaxContext, rates: TaxRateTable): TaxResult {
    const result = emptyResult();

    const sellerGstin = context.sellerRegistrations.find((r) => r.regime === "GST_IN");
    if (!sellerGstin) {
      result.errors.push(
        taxError(
          "SELLER_NOT_REGISTERED",
          "This book has no GSTIN. Add one in accounting settings before issuing a tax invoice.",
        ),
      );
      return result;
    }

    const supplierState = sellerGstin.region ?? stateFromGstin(sellerGstin.number);
    if (!supplierState) {
      result.errors.push(
        taxError("SELLER_STATE_UNKNOWN", `Cannot read a state code from GSTIN ${sellerGstin.number}`),
      );
      return result;
    }

    // Place of supply drives the whole split. For B2B services the buyer's
    // GSTIN state is the default; the document may override it explicitly.
    const buyerGstin = context.buyerRegistrations.find((r) => r.regime === "GST_IN");
    const placeOfSupply =
      context.to.region ?? (buyerGstin ? stateFromGstin(buyerGstin.number) : null);

    const isExport = context.supplyNature === "export" || context.to.countryCode !== "IN";
    const isReverseCharge = context.supplyNature === "reverse_charge";

    if (!isExport && !placeOfSupply) {
      result.errors.push(
        taxError(
          "PLACE_OF_SUPPLY_MISSING",
          "Place of supply is required for a domestic supply. Set the customer's state.",
        ),
      );
      return result;
    }

    const interState = isExport || placeOfSupply !== supplierState;
    const isUnionTerritory = !interState && UNION_TERRITORY_CODES.has(supplierState);

    for (const line of context.lines) {
      const resolved = this.resolveCode(line, rates);
      if (!resolved) {
        result.errors.push(
          taxError(
            "TAX_CODE_UNRESOLVED",
            `No GST rate is configured for a ${line.taxCategory} line on ${context.documentDate}`,
            line.id,
          ),
        );
        continue;
      }

      // HSN/SAC is a GSTR-1 table 12 requirement on B2B lines. Warn rather than
      // block so a founder is never stuck mid-invoice (M3).
      if (!line.commodityCode && context.supplyNature === "domestic_b2b") {
        result.warnings.push(
          taxError("HSN_MISSING", "HSN/SAC is required on B2B lines for GSTR-1", line.id),
        );
      }

      const wanted = this.componentsFor(resolved.components, {
        interState,
        isUnionTerritory,
        isExport,
        exportWithIgst: context.flags?.exportWithIgst ?? false,
      });

      const components: TaxComponentResult[] = [];
      let taxableMinor = line.taxableMinor;

      if (context.taxInclusive && wanted.length > 0) {
        // Back the whole tax out of the gross once, then split — splitting a
        // gross figure per component would round twice and lose a paisa.
        const totalBp = wanted.reduce((a, c) => a + c.rateBp, 0);
        const embedded = extractInclusiveTax(money(line.taxableMinor, context.currency), totalBp);
        taxableMinor = line.taxableMinor - embedded.minor;
      }

      const base = money(taxableMinor, context.currency);
      const glRole = this.glRoleFor(context.direction, isReverseCharge);

      for (const component of wanted) {
        const taxMinor = applyBasisPoints(base, component.rateBp).minor;
        components.push({
          code: component.component,
          jurisdiction: component.jurisdiction,
          rateBp: component.rateBp,
          taxableMinor,
          taxMinor,
          recoverable: context.direction === "purchase" && !context.flags?.blockedInput,
          glRole,
        });

        // Reverse charge produces both legs: the buyer owes the tax and (unless
        // blocked) reclaims it in the same breath, netting GST to zero.
        if (isReverseCharge && context.direction === "purchase") {
          components.push({
            code: component.component,
            jurisdiction: component.jurisdiction,
            rateBp: component.rateBp,
            taxableMinor,
            taxMinor,
            recoverable: false,
            glRole: "reverse_charge_output",
          });
        }
      }

      const totalTaxMinor = components
        .filter((c) => c.glRole !== "reverse_charge_output")
        .reduce((a, c) => a + c.taxMinor, 0);

      result.lines.push({
        documentLineId: line.id,
        taxCodeId: resolved.id,
        taxCode: resolved.code,
        category: resolved.category,
        taxableMinor,
        components,
        totalTaxMinor,
      } satisfies TaxLineResult);
    }

    result.totalTaxMinor = result.lines.reduce((a, l) => a + l.totalTaxMinor, 0);
    return result;
  }

  /**
   * Pick the components that actually apply. The rate rows carry every
   * possibility (CGST, SGST, IGST, UTGST); geography decides which are used, so
   * a rate change is a data edit and never a code change.
   */
  private componentsFor(
    available: ReadonlyArray<{ component: string; jurisdiction: string; rateBp: number }>,
    ctx: { interState: boolean; isUnionTerritory: boolean; isExport: boolean; exportWithIgst: boolean },
  ): Array<{ component: string; jurisdiction: string; rateBp: number }> {
    if (available.length === 0) return [];

    if (ctx.isExport && !ctx.exportWithIgst) {
      // Zero-rated export under LUT: the IGST component still appears, at 0, so
      // the invoice shows the split and GSTR still sees the supply.
      return available.filter((c) => c.component === "IGST").map((c) => ({ ...c, rateBp: 0 }));
    }

    if (ctx.interState) {
      return available.filter((c) => c.component === "IGST" || c.component === "CESS").map((c) => ({ ...c }));
    }

    // Never CGST without its partner, and never both SGST and UTGST (M2).
    const localComponent = ctx.isUnionTerritory ? "UTGST" : "SGST";
    return available
      .filter((c) => c.component === "CGST" || c.component === localComponent || c.component === "CESS")
      .map((c) => ({ ...c }));
  }

  private resolveCode(line: TaxContext["lines"][number], rates: TaxRateTable) {
    return line.forceTaxCodeId
      ? (rates.byId.get(line.forceTaxCodeId) ?? null)
      : this.codeForCategory(line.taxCategory, rates);
  }

  /**
   * Map a generic category onto this pack's code. Services at 18% is the ICP's
   * overwhelming case, so `standard` resolves there.
   */
  private codeForCategory(category: TaxContext["lines"][number]["taxCategory"], rates: TaxRateTable) {
    const preference: Record<string, string[]> = {
      standard: ["IN_GST_18"],
      reduced: ["IN_GST_5"],
      super_reduced: ["IN_GST_3", "IN_GST_5"],
      zero: ["IN_GST_0"],
      exempt: ["IN_GST_0"],
      out_of_scope: ["IN_GST_0"],
      reverse_charge: ["IN_RCM_18", "IN_GST_18"],
    };
    for (const code of preference[category] ?? []) {
      const found = rates.byCode.get(code);
      if (found) return found;
    }
    return null;
  }

  private glRoleFor(direction: TaxContext["direction"], isReverseCharge: boolean) {
    if (direction === "sale") return "output_payable" as const;
    return isReverseCharge ? ("reverse_charge_input" as const) : ("input_recoverable" as const);
  }

  /**
   * Seed rates. **As-of 2026-08 and explicitly not legal advice** — after the
   * 56th Council the working slabs are commonly described as 5/18/40 with a
   * 3% rate for bullion, and 12/28 largely retired. Kept as dated rows so a
   * correction is an INSERT, not a deploy.
   */
  seedCodes(): SeedTaxCode[] {
    const from = "2017-07-01";
    const split = (total: number) => [
      { component: "CGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
      { component: "SGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
      { component: "UTGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
      { component: "IGST", jurisdiction: "IN", rateBp: total, effectiveFrom: from },
    ];

    return [
      {
        code: "IN_GST_18",
        name: "GST 18%",
        category: "standard",
        description: "Standard rate — most services, including SaaS",
        rates: split(1800),
      },
      {
        code: "IN_GST_5",
        name: "GST 5%",
        category: "reduced",
        rates: split(500),
      },
      {
        code: "IN_GST_3",
        name: "GST 3%",
        category: "super_reduced",
        description: "Bullion and specified goods",
        rates: split(300),
      },
      {
        code: "IN_GST_40",
        name: "GST 40%",
        category: "standard",
        description: "Demerit rate introduced by the 56th Council",
        rates: split(4000),
      },
      {
        code: "IN_GST_0",
        name: "GST 0% / exempt",
        category: "zero",
        rates: split(0),
      },
      {
        code: "IN_RCM_18",
        name: "GST 18% reverse charge",
        category: "reverse_charge",
        description: "Recipient accounts for the tax (GTA, legal, import of services)",
        rates: split(1800),
      },
      {
        code: "IN_EXP_0",
        name: "Export — zero rated",
        category: "zero",
        description: "Export under LUT; set exportWithIgst to charge IGST instead",
        rates: [{ component: "IGST", jurisdiction: "IN", rateBp: 0, effectiveFrom: from }],
      },
      // Legacy slabs, so historical documents and migrations still resolve.
      { code: "IN_GST_12", name: "GST 12% (legacy)", category: "reduced", rates: split(1200) },
      { code: "IN_GST_28", name: "GST 28% (legacy)", category: "standard", rates: split(2800) },
    ];
  }
}
