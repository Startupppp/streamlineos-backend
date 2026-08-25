import { applyBasisPoints, extractInclusiveTax, money } from "../../kernel/money";
import {
  emptyResult,
  taxError,
  type SeedTaxCode,
  type TaxComponentResult,
  type TaxContext,
  type TaxEngine,
  type TaxRateTable,
  type TaxResult,
} from "../tax.types";

/**
 * A single-rate VAT regime — pack `GENERIC_VAT`.
 *
 * Deliberately small. Its job is to let a founder outside India keep correct
 * books today, and to prove the engine really is pluggable: the same invoice
 * document produces a different tax split here than under pack `IN`, with no
 * change to AR.
 *
 * Real EU place-of-supply, OSS and intra-community reverse charge are a later
 * pack (PRD 12), not a patch to this one.
 */
export class GenericVatEngine implements TaxEngine {
  readonly pack = "GENERIC_VAT";
  readonly status = "enabled" as const;

  determine(context: TaxContext, rates: TaxRateTable): TaxResult {
    const result = emptyResult();
    const isReverseCharge = context.supplyNature === "reverse_charge";
    const isOutOfScope =
      context.supplyNature === "export" || context.supplyNature === "outside_scope";

    for (const line of context.lines) {
      const resolved = line.forceTaxCodeId
        ? rates.byId.get(line.forceTaxCodeId)
        : this.codeForCategory(line.taxCategory, isOutOfScope, rates);

      if (!resolved) {
        result.errors.push(
          taxError(
            "TAX_CODE_UNRESOLVED",
            `No VAT rate is configured for a ${line.taxCategory} line on ${context.documentDate}`,
            line.id,
          ),
        );
        continue;
      }

      const components: TaxComponentResult[] = [];
      let taxableMinor = line.taxableMinor;
      const totalBp = resolved.components.reduce((a, c) => a + c.rateBp, 0);

      if (context.taxInclusive && totalBp > 0) {
        const embedded = extractInclusiveTax(money(line.taxableMinor, context.currency), totalBp);
        taxableMinor = line.taxableMinor - embedded.minor;
      }

      const base = money(taxableMinor, context.currency);
      const glRole =
        context.direction === "sale"
          ? ("output_payable" as const)
          : isReverseCharge
            ? ("reverse_charge_input" as const)
            : ("input_recoverable" as const);

      for (const component of resolved.components) {
        const taxMinor = applyBasisPoints(base, component.rateBp).minor;
        components.push({
          code: component.component,
          jurisdiction: component.jurisdiction || context.to.countryCode,
          rateBp: component.rateBp,
          taxableMinor,
          taxMinor,
          recoverable: context.direction === "purchase" && !context.flags?.blockedInput,
          glRole,
        });

        // Intra-community acquisitions: the buyer self-accounts on both sides.
        if (isReverseCharge && context.direction === "purchase") {
          components.push({
            code: component.component,
            jurisdiction: component.jurisdiction || context.to.countryCode,
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
      });
    }

    result.totalTaxMinor = result.lines.reduce((a, l) => a + l.totalTaxMinor, 0);
    return result;
  }

  private codeForCategory(
    category: TaxContext["lines"][number]["taxCategory"],
    isOutOfScope: boolean,
    rates: TaxRateTable,
  ) {
    if (isOutOfScope) return rates.byCode.get("VAT_ZERO") ?? null;
    const preference: Record<string, string[]> = {
      standard: ["VAT_STD"],
      reduced: ["VAT_RED", "VAT_STD"],
      super_reduced: ["VAT_RED", "VAT_STD"],
      zero: ["VAT_ZERO"],
      exempt: ["VAT_EXEMPT", "VAT_ZERO"],
      out_of_scope: ["VAT_ZERO"],
      reverse_charge: ["VAT_STD"],
    };
    for (const code of preference[category] ?? []) {
      const found = rates.byCode.get(code);
      if (found) return found;
    }
    return null;
  }

  /**
   * 20% standard is the most common European headline rate and a reasonable
   * default; a tenant edits the rate row rather than the code. Dated from the
   * epoch of the euro so any document date resolves.
   */
  seedCodes(): SeedTaxCode[] {
    const effectiveFrom = "2000-01-01";
    return [
      {
        code: "VAT_STD",
        name: "VAT standard rate",
        category: "standard",
        description: "Edit the rate to match your jurisdiction",
        rates: [{ component: "VAT", jurisdiction: "", rateBp: 2000, effectiveFrom }],
      },
      {
        code: "VAT_RED",
        name: "VAT reduced rate",
        category: "reduced",
        rates: [{ component: "VAT", jurisdiction: "", rateBp: 500, effectiveFrom }],
      },
      {
        code: "VAT_ZERO",
        name: "VAT zero rated",
        category: "zero",
        rates: [{ component: "VAT", jurisdiction: "", rateBp: 0, effectiveFrom }],
      },
      {
        code: "VAT_EXEMPT",
        name: "VAT exempt",
        category: "exempt",
        rates: [{ component: "VAT", jurisdiction: "", rateBp: 0, effectiveFrom }],
      },
    ];
  }
}

/**
 * A registered-but-unimplemented pack.
 *
 * It exists so the country is selectable, the chart is seeded and the schema
 * holds the right fields — but determination **fails loudly**. Returning zero
 * tax silently is the one outcome worse than an error (PRD 10 M2): a founder
 * would ship a year of untaxed invoices and find out at their first audit.
 */
export class StubTaxEngine implements TaxEngine {
  readonly status = "stub" as const;

  constructor(
    readonly pack: string,
    private readonly title: string,
  ) {}

  determine(context: TaxContext): TaxResult {
    const result = emptyResult();
    result.errors.push(
      taxError(
        "PACK_NOT_CONFIGURED",
        `Tax determination for ${this.title} (${this.pack}) is not implemented yet. ` +
          "Switch this book to the generic VAT pack, or enter tax manually.",
      ),
    );
    // Echo the lines back with no components so a preview screen can still show
    // the net figures next to the error.
    result.lines = context.lines.map((line) => ({
      documentLineId: line.id,
      taxCodeId: null,
      taxCode: "",
      category: line.taxCategory,
      taxableMinor: line.taxableMinor,
      components: [],
      totalTaxMinor: 0,
    }));
    return result;
  }

  seedCodes(): SeedTaxCode[] {
    return [];
  }
}
