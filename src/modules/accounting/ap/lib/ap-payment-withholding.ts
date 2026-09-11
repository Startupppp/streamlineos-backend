import { BadRequestException } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apPayments, apWithholding } from "../../../../db/schema";
import type { BooksService } from "../../kernel/books.service";
import { divideRoundHalfUp } from "../../kernel/money";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { TaxService } from "../../tax/tax.service";
import type { ApVendor } from "../ap.vendor-lookup";
import type { AllocationInput, WithholdingInstruction } from "../dto/ap-payments.schemas";
import type { WithholdingEngineRegistry } from "../withholding/withholding.registry";
import type { WithholdingResult } from "../withholding/withholding.types";
import type { AllocationTarget } from "./ap-settlement";

/** The collaborators withholding needs, handed over by the payments service. */
export interface WithholdingDeps {
  books: BooksService;
  tax: TaxService;
  withholdingEngines: WithholdingEngineRegistry;
}

/**
 * How much to keep back.
 *
 * The base defaults to the **tax-exclusive** value of what is being paid,
 * split out of each allocated bill in the proportion the bill itself carries,
 * because most regimes (India TDS included) withhold on the invoice value
 * before GST. An unallocated advance has no such split, so it is taken at
 * face value; a caller who knows better states `baseMinor` outright.
 */
export async function determineWithholding(
  deps: WithholdingDeps,
  tx: DbOrTx,
  args: {
    orgId: string;
    book: { id: string; localizationPack: string };
    vendor: ApVendor;
    paymentDate: string;
    currency: string;
    grossMinor: number;
    allocatedMinor: number;
    allocations: readonly AllocationInput[];
    targets: Map<string, AllocationTarget>;
    instruction?: WithholdingInstruction;
  },
): Promise<WithholdingResult> {
  const instruction = args.instruction ?? { mode: "auto" as const };
  const engine = deps.withholdingEngines.forPack(args.book.localizationPack);
  const baseMinor = instruction.baseMinor ?? withholdingBase(args);

  if (instruction.mode === "none") {
    return {
      regime: engine.regime,
      applicable: false,
      legacySection: null,
      paymentCode: null,
      rateBp: 0,
      baseMinor,
      withheldMinor: 0,
      reason: instruction.reason ?? "No tax withheld on this payment",
    };
  }

  const code = instruction.code ?? args.vendor.withholdingCode ?? null;

  if (instruction.mode === "manual" && instruction.withheldMinor != null) {
    // A stated amount is the instruction; the rate is derived only so the
    // stored row still explains itself on a certificate.
    const rateBp =
      baseMinor > 0
        ? Number(divideRoundHalfUp(BigInt(instruction.withheldMinor) * 10_000n, BigInt(baseMinor)))
        : 0;
    const named = code ? engine.determine({ ...baseContext(args, baseMinor, code), overrideRateBp: 0 }) : null;
    return {
      regime: engine.regime,
      applicable: instruction.withheldMinor > 0,
      legacySection: named?.legacySection ?? null,
      paymentCode: named?.paymentCode ?? null,
      rateBp: Math.min(Math.max(rateBp, 0), 10_000),
      baseMinor,
      withheldMinor: instruction.withheldMinor,
      reason: instruction.reason ?? "Amount stated on the payment",
    };
  }

  const context = {
    ...baseContext(args, baseMinor, code),
    taxIdOnFile:
      instruction.taxIdOnFile ??
      ((await deps.tax.loadRegistrations("party", args.vendor.id, tx)).length > 0),
    cumulativeBaseMinor:
      instruction.cumulativeBaseMinor ??
      (code ? await cumulativeWithheldBase(deps.books, tx, args, code) : 0),
    overrideRateBp: instruction.mode === "manual" ? (instruction.rateBp ?? null) : null,
    overrideReason: instruction.reason ?? null,
  };

  const result = engine.determine(context);
  if (result.withheldMinor > args.grossMinor) {
    throw new BadRequestException(
      `Withholding of ${result.withheldMinor} exceeds the payment of ${args.grossMinor}`,
    );
  }
  return result;
}

export async function resolveWithholdingAccount(
  deps: Pick<WithholdingDeps, "books" | "tax">,
  tx: DbOrTx,
  bookId: string,
): Promise<string> {
  // The tax GL map is the first answer, so a pack that maps withholding
  // somewhere other than the default tag is honoured without a code change.
  const glMap = await deps.tax.loadGlMap(bookId, tx);
  return glMap.get("withheld:WHT") ?? (await deps.books.resolveAccountByTag(bookId, "wht_payable", tx));
}

function baseContext(
  args: {
    vendor: ApVendor;
    paymentDate: string;
    currency: string;
    instruction?: WithholdingInstruction;
  },
  baseMinor: number,
  code: string | null,
) {
  return {
    paymentDate: args.paymentDate,
    currency: args.currency,
    baseMinor,
    withholdingCode: code,
    payeeType: args.instruction?.payeeType ?? undefined,
  };
}

function withholdingBase(args: {
  grossMinor: number;
  allocatedMinor: number;
  allocations: readonly AllocationInput[];
  targets: Map<string, AllocationTarget>;
}): number {
  let base = 0;
  for (const allocation of args.allocations) {
    const target = args.targets.get(allocation.documentId);
    if (!target || target.grossMinor <= 0) {
      base += allocation.amountMinor;
      continue;
    }
    base += Number(
      divideRoundHalfUp(
        BigInt(allocation.amountMinor) * BigInt(target.netMinor),
        BigInt(target.grossMinor),
      ),
    );
  }
  return base + (args.grossMinor - args.allocatedMinor);
}

/** Year-to-date base under the same code, for an annual threshold. */
async function cumulativeWithheldBase(
  books: BooksService,
  tx: DbOrTx,
  args: { orgId: string; book: { id: string }; vendor: ApVendor; paymentDate: string },
  code: string,
): Promise<number> {
  const year = await books.ensureFiscalYear(
    args.orgId,
    args.book.id,
    args.paymentDate,
    tx,
  );
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${apWithholding.baseMinor}), 0)` })
    .from(apWithholding)
    .innerJoin(apPayments, eq(apWithholding.paymentId, apPayments.id))
    .where(
      and(
        eq(apWithholding.orgId, args.orgId),
        eq(apWithholding.bookId, args.book.id),
        eq(apPayments.partyId, args.vendor.id),
        eq(apPayments.status, "POSTED"),
        gte(apPayments.paymentDate, year.startsOn),
        lte(apPayments.paymentDate, year.endsOn),
        sql`(${apWithholding.legacySection} = ${code} OR ${apWithholding.paymentCode} = ${code})`,
      ),
    );
  return Number(row?.total ?? 0);
}
