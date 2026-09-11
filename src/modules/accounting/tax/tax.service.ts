import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  glAccounts,
  glBooks,
  taxCodes,
  taxDocumentLines,
  taxGlMap,
  taxRates,
  taxRegistrations,
  type GlSystemTag,
  type TaxGlRole,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import { TaxEngineRegistry } from "./tax-engine.registry";
import type {
  ResolvedTaxCode,
  TaxContext,
  TaxContextRegistration,
  TaxRateTable,
  TaxResult,
} from "./tax.types";

/**
 * Which GL account each (role, component) pair posts to, expressed as system
 * tags so it survives a tenant renumbering their chart.
 *
 * India needs the full grid; a single-rate VAT regime needs two rows. Both are
 * data here rather than branches in AP.
 */
const GST_COMPONENT_TAGS: Record<string, { input: GlSystemTag; output: GlSystemTag }> = {
  CGST: { input: "gst_input_cgst", output: "gst_output_cgst" },
  SGST: { input: "gst_input_sgst", output: "gst_output_sgst" },
  IGST: { input: "gst_input_igst", output: "gst_output_igst" },
  UTGST: { input: "gst_input_utgst", output: "gst_output_utgst" },
  CESS: { input: "gst_input_cess", output: "gst_output_cess" },
};

const VAT_COMPONENT_TAGS: Record<string, { input: GlSystemTag; output: GlSystemTag }> = {
  VAT: { input: "vat_input", output: "vat_output" },
};

const US_COMPONENT_TAGS: Record<string, { input: GlSystemTag; output: GlSystemTag }> = {
  STATE: { input: "sales_tax_payable", output: "sales_tax_payable" },
};

function componentTagsFor(pack: string) {
  if (pack === "IN") return GST_COMPONENT_TAGS;
  if (pack === "US") return US_COMPONENT_TAGS;
  return VAT_COMPONENT_TAGS;
}

/** Roles that debit a tax asset vs credit a tax liability. */
const INPUT_ROLES: TaxGlRole[] = ["input_recoverable", "reverse_charge_input"];
const OUTPUT_ROLES: TaxGlRole[] = ["output_payable", "reverse_charge_output"];

export interface DetermineResult extends TaxResult {
  /** Resolved GL account per component, so the caller need not look them up. */
  accountByRoleAndComponent: Map<string, string>;
}

@Injectable()
export class TaxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engines: TaxEngineRegistry,
  ) {}

  /* ------------------------------------------------------------ seeding */

  /**
   * Install a pack's tax codes, rates and GL mapping. Idempotent — re-running
   * after an upgrade adds what is new and leaves edited rates alone.
   */
  async seedPack(orgId: string, bookId: string, pack: string, tx: DbOrTx = this.db): Promise<void> {
    const engine = this.engines.get(pack);

    for (const seed of engine.seedCodes()) {
      const [code] = await tx
        .insert(taxCodes)
        .values({
          orgId,
          bookId,
          pack,
          code: seed.code,
          name: seed.name,
          category: seed.category,
          description: seed.description ?? null,
          isSystem: true,
        })
        .onConflictDoNothing()
        .returning({ id: taxCodes.id });

      const taxCodeId = code?.id ?? (await this.findCodeId(bookId, seed.code, tx));
      if (!taxCodeId) continue;

      if (seed.rates.length > 0) {
        await tx
          .insert(taxRates)
          .values(
            seed.rates.map((r) => ({
              orgId,
              taxCodeId,
              component: r.component,
              jurisdiction: r.jurisdiction,
              rateBp: r.rateBp,
              effectiveFrom: r.effectiveFrom,
              effectiveTo: r.effectiveTo ?? null,
            })),
          )
          .onConflictDoNothing();
      }
    }

    await this.seedGlMap(orgId, bookId, pack, tx);
  }

  /** Wire each (role, component) to the account the pack tagged for it. */
  private async seedGlMap(
    orgId: string,
    bookId: string,
    pack: string,
    tx: DbOrTx,
  ): Promise<void> {
    const tags = componentTagsFor(pack);
    const accounts = await tx
      .select({ id: glAccounts.id, systemTag: glAccounts.systemTag })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, bookId), isNull(glAccounts.deletedAt)));
    const byTag = new Map(accounts.filter((a) => a.systemTag).map((a) => [a.systemTag!, a.id]));

    const rows: Array<{ orgId: string; bookId: string; glRole: TaxGlRole; component: string; accountId: string }> = [];
    for (const [component, pair] of Object.entries(tags)) {
      for (const role of INPUT_ROLES) {
        const accountId = byTag.get(pair.input);
        if (accountId) rows.push({ orgId, bookId, glRole: role, component, accountId });
      }
      for (const role of OUTPUT_ROLES) {
        const accountId = byTag.get(pair.output);
        if (accountId) rows.push({ orgId, bookId, glRole: role, component, accountId });
      }
      // Blocked input is an expense, not a recoverable asset (PRD 03 M8).
      const blocked = byTag.get("opex");
      if (blocked) {
        rows.push({ orgId, bookId, glRole: "blocked_input", component, accountId: blocked });
      }
    }

    const withheld = byTag.get("wht_payable");
    if (withheld) {
      rows.push({ orgId, bookId, glRole: "withheld", component: "WHT", accountId: withheld });
    }

    if (rows.length > 0) {
      await tx.insert(taxGlMap).values(rows).onConflictDoNothing();
    }
  }

  private async findCodeId(bookId: string, code: string, tx: DbOrTx): Promise<string | null> {
    const [row] = await tx
      .select({ id: taxCodes.id })
      .from(taxCodes)
      .where(and(eq(taxCodes.bookId, bookId), eq(taxCodes.code, code)))
      .limit(1);
    return row?.id ?? null;
  }

  /* ------------------------------------------------------- determination */

  /**
   * Rates in force on a given date, keyed both ways so an engine can resolve by
   * category or by a forced code id.
   *
   * The date filter is the whole point: a rate row added tomorrow has an
   * `effective_from` beyond today's document and simply is not returned.
   */
  async loadRateTable(
    bookId: string,
    documentDate: string,
    tx: DbOrTx = this.db,
  ): Promise<TaxRateTable> {
    const rows = await tx
      .select({
        id: taxCodes.id,
        code: taxCodes.code,
        category: taxCodes.category,
        component: taxRates.component,
        jurisdiction: taxRates.jurisdiction,
        rateBp: taxRates.rateBp,
      })
      .from(taxCodes)
      .innerJoin(taxRates, eq(taxRates.taxCodeId, taxCodes.id))
      .where(
        and(
          eq(taxCodes.bookId, bookId),
          eq(taxCodes.isActive, true),
          lte(taxRates.effectiveFrom, documentDate),
          or(isNull(taxRates.effectiveTo), gte(taxRates.effectiveTo, documentDate)),
        ),
      );

    const byCode = new Map<string, ResolvedTaxCode>();
    for (const row of rows) {
      const existing = byCode.get(row.code);
      const component = {
        component: row.component,
        jurisdiction: row.jurisdiction,
        rateBp: row.rateBp,
      };
      if (existing) {
        existing.components.push(component);
      } else {
        byCode.set(row.code, {
          id: row.id,
          code: row.code,
          category: row.category,
          components: [component],
        });
      }
    }

    const byId = new Map<string, ResolvedTaxCode>();
    for (const resolved of byCode.values()) {
      if (resolved.id) byId.set(resolved.id, resolved);
    }

    return { byCode, byId };
  }

  /** Registrations the engine consults — the book's own, and a party's. */
  async loadRegistrations(
    ownerType: "book" | "party",
    ownerId: string,
    tx: DbOrTx = this.db,
  ): Promise<TaxContextRegistration[]> {
    const rows = await tx
      .select({
        regime: taxRegistrations.regime,
        number: taxRegistrations.number,
        region: taxRegistrations.region,
        countryCode: taxRegistrations.countryCode,
      })
      .from(taxRegistrations)
      .where(
        and(
          eq(taxRegistrations.ownerType, ownerType),
          ownerType === "book"
            ? eq(taxRegistrations.bookId, ownerId)
            : eq(taxRegistrations.partyId, ownerId),
        ),
      );
    return rows;
  }

  /**
   * Run determination for a document.
   *
   * Never writes a journal line and never writes to the ledger — it returns
   * numbers plus the accounts they belong in, and the document layer decides
   * what to do with them.
   */
  async determine(bookId: string, context: TaxContext, tx: DbOrTx = this.db): Promise<DetermineResult> {
    const [book] = await tx
      .select({ localizationPack: glBooks.localizationPack })
      .from(glBooks)
      .where(eq(glBooks.id, bookId))
      .limit(1);
    if (!book) throw new NotFoundException("Book not found");

    const engine = this.engines.get(book.localizationPack);
    const rates = await this.loadRateTable(bookId, context.documentDate, tx);
    const result = engine.determine(context, rates);

    const accountByRoleAndComponent = await this.loadGlMap(bookId, tx);
    return { ...result, accountByRoleAndComponent };
  }

  /** `${role}:${component}` -> account id. */
  async loadGlMap(bookId: string, tx: DbOrTx = this.db): Promise<Map<string, string>> {
    const rows = await tx
      .select({
        glRole: taxGlMap.glRole,
        component: taxGlMap.component,
        accountId: taxGlMap.accountId,
      })
      .from(taxGlMap)
      .where(eq(taxGlMap.bookId, bookId));
    return new Map(rows.map((r) => [`${r.glRole}:${r.component}`, r.accountId]));
  }

  /* ------------------------------------------------------------ freezing */

  /**
   * Persist the engine's verdict against the posted document.
   *
   * These rows are the tax summary's only source. Re-determining at report time
   * would let a rate edited next month rewrite last month's return.
   */
  async freezeDocumentTaxLines(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    currency: string,
    result: DetermineResult,
    tx: DbOrTx,
  ): Promise<void> {
    const rows = result.lines.flatMap((line) =>
      line.components.map((component) => ({
        orgId,
        bookId,
        documentType,
        documentId,
        documentLineId: line.documentLineId,
        taxCodeId: line.taxCodeId,
        component: component.code,
        jurisdiction: component.jurisdiction,
        rateBp: component.rateBp,
        taxableMinor: component.taxableMinor,
        taxMinor: component.taxMinor,
        currency,
        glRole: component.glRole,
        recoverable: component.recoverable,
        glAccountId:
          result.accountByRoleAndComponent.get(`${component.glRole}:${component.code}`) ?? null,
        rawResult: { taxCode: line.taxCode, category: line.category } as Record<string, unknown>,
      })),
    );

    if (rows.length > 0) await tx.insert(taxDocumentLines).values(rows);
  }

  /** Tax summary for a period, grouped the way a return expects (PRD 06 M6). */
  async summary(
    orgId: string,
    bookId: string,
    from: string,
    to: string,
    tx: DbOrTx = this.db,
  ): Promise<
    Array<{ glRole: TaxGlRole; component: string; taxableMinor: number; taxMinor: number }>
  > {
    const rows = await tx
      .select({
        glRole: taxDocumentLines.glRole,
        component: taxDocumentLines.component,
        taxableMinor: sql<string>`coalesce(sum(${taxDocumentLines.taxableMinor}), 0)`,
        taxMinor: sql<string>`coalesce(sum(${taxDocumentLines.taxMinor}), 0)`,
      })
      .from(taxDocumentLines)
      .where(
        and(
          eq(taxDocumentLines.orgId, orgId),
          eq(taxDocumentLines.bookId, bookId),
          gte(taxDocumentLines.createdAt, new Date(`${from}T00:00:00Z`)),
          lte(taxDocumentLines.createdAt, new Date(`${to}T23:59:59Z`)),
        ),
      )
      .groupBy(taxDocumentLines.glRole, taxDocumentLines.component);

    return rows.map((r) => ({
      glRole: r.glRole,
      component: r.component,
      taxableMinor: Number(r.taxableMinor),
      taxMinor: Number(r.taxMinor),
    }));
  }
}
