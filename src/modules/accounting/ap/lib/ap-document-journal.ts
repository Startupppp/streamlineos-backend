import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { GlSystemTag } from "../../../../db/schema";
import type { BooksService } from "../../kernel/books.service";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { TaxComponentResult } from "../../tax/tax.types";
import { draft, flip, type JournalDraftLine, type PostingSide } from "../ap.posting";
import type { ApVendor } from "../ap.vendor-lookup";
import type { DocumentRow, LineRow } from "./ap-document-rows";
import { INPUT_ROLES, OUTPUT_ROLES, type ComputedTotals } from "./ap-document-tax";

/**
 * Dr expense or asset per line, Dr recoverable tax per component, Cr AP with
 * the gross — with every side flipped when the document is a debit note.
 */
export async function buildJournalDrafts(
  books: BooksService,
  tx: DbOrTx,
  doc: DocumentRow,
  lines: LineRow[],
  vendor: ApVendor,
  totals: ComputedTotals,
): Promise<JournalDraftLine[]> {
  const isBill = doc.documentType === "BILL";
  const orient = (side: PostingSide): PostingSide => (isBill ? side : flip(side));

  const fallbackTags: GlSystemTag[] = ["opex", "fixed_asset", "ap_control"];
  const tagged = await books.resolveAccountsByTag(doc.bookId, fallbackTags, tx);
  const blockedFallbackId = tagged.get("opex")!;

  const drafts: JournalDraftLine[] = [];

  for (const line of lines) {
    const computed = totals.perLine.get(line.id);
    if (!computed || computed.netMinor === 0) continue;
    const accountId =
      line.expenseAccountId ??
      vendor.defaultExpenseAccountId ??
      (line.capitalize ? tagged.get("fixed_asset")! : tagged.get("opex")!);

    drafts.push(
      draft(accountId, orient("debit"), computed.netMinor, {
        description: line.description,
        partyId: doc.partyId,
        dimensionProjectId: line.dimensionProjectId ?? doc.dimensionProjectId ?? undefined,
        dimensionCostCenterId: line.dimensionCostCenterId ?? undefined,
      }),
    );
  }

  // One journal line per (role, component, code), not per document line, so a
  // twenty-line bill still produces a readable CGST/SGST pair.
  const buckets = new Map<
    string,
    { accountId: string; side: PostingSide; amount: number; component: string; taxCodeId: string | null }
  >();

  for (const taxLine of totals.determination.lines) {
    for (const component of taxLine.components) {
      if (component.taxMinor === 0) continue;
      const placement = placeComponent(
        component,
        totals.determination.accountByRoleAndComponent,
        blockedFallbackId,
      );
      const key = `${component.glRole}:${component.code}:${component.recoverable}:${taxLine.taxCodeId ?? ""}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.amount += component.taxMinor;
      else
        buckets.set(key, {
          accountId: placement.accountId,
          side: placement.side,
          amount: component.taxMinor,
          component: component.code,
          taxCodeId: taxLine.taxCodeId,
        });
    }
  }

  for (const bucket of buckets.values()) {
    drafts.push(
      draft(bucket.accountId, orient(bucket.side), bucket.amount, {
        description: `${bucket.component} on ${vendor.displayName}`,
        partyId: doc.partyId,
        taxCodeId: bucket.taxCodeId ?? undefined,
        taxComponent: bucket.component,
      }),
    );
  }

  // Accounts payable carries the **gross** the vendor is owed, rounding
  // included — the rounding account absorbs the difference so the journal
  // still balances at zero tolerance rather than AP carrying a stray paisa.
  drafts.push(
    draft(tagged.get("ap_control")!, orient("credit"), totals.grossMinor, {
      description: vendor.displayName,
      partyId: doc.partyId,
    }),
  );

  return drafts;
}

/**
 * Where a component lands, decided purely from the role the engine returned.
 *
 * Blocked input tax (India s17(5), entertainment elsewhere) arrives as an
 * input role with `recoverable: false`. It is a cost, not a receivable from
 * the state, so it goes to the `blocked_input` account rather than to a tax
 * asset — PRD 03 M8, and the reason `tax_gl_map` has that role at all.
 */
function placeComponent(
  component: TaxComponentResult,
  glMap: Map<string, string>,
  blockedFallbackId: string,
): { accountId: string; side: PostingSide } {
  if (INPUT_ROLES.has(component.glRole)) {
    if (!component.recoverable) {
      return {
        accountId: glMap.get(`blocked_input:${component.code}`) ?? blockedFallbackId,
        side: "debit",
      };
    }
    return { accountId: requireMapped(glMap, component), side: "debit" };
  }
  if (OUTPUT_ROLES.has(component.glRole)) {
    return { accountId: requireMapped(glMap, component), side: "credit" };
  }
  if (component.glRole === "blocked_input") {
    return {
      accountId: glMap.get(`blocked_input:${component.code}`) ?? blockedFallbackId,
      side: "debit",
    };
  }
  throw new BadRequestException(
    `Tax role ${component.glRole} does not belong on a purchase document`,
  );
}

function requireMapped(glMap: Map<string, string>, component: TaxComponentResult): string {
  const accountId = glMap.get(`${component.glRole}:${component.code}`);
  if (!accountId) {
    throw new NotFoundException(
      `No GL account is mapped for ${component.code} (${component.glRole}) in this book. ` +
        "Re-run the tax pack setup in accounting settings.",
    );
  }
  return accountId;
}
