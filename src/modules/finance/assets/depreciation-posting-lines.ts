import { UnprocessableEntityException } from "@nestjs/common";
import type { DraftLine } from "../../accounting/posting/journal-posting.service";
import type { BulkUpdateRow } from "../../../common/db/bulk-update";

/**
 * The depreciation arithmetic, separated from the run orchestration in
 * `DepreciationRunsService`. Everything here is pure: it takes the joined
 * schedule/asset/category rows a run has already read and produces the journal
 * lines and the asset-register updates the run then persists. Keeping the
 * rounding, the debit/credit pairing and the fully-depreciated threshold out of
 * the transaction is what makes them checkable without a database, and it is the
 * half that changes when the accounting policy changes rather than when the
 * persistence does.
 */

const SCALE = 10000;

export function roundAmount(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

export interface DepreciationScheduleRow {
  schedule: { id: number; amount: string | number };
  asset: {
    id: number;
    accumulatedDepreciation: string | number;
    acquisitionCost: string | number;
    salvageValue: string | number;
  };
  category: {
    id: number;
    depreciationExpenseAccountId: number;
    accumulatedDepreciationAccountId: number;
  };
}

export interface CategoryAmount {
  depExpAccountId: number;
  accumDepAccountId: number;
  total: number;
  scheduleIds: number[];
}

export function groupSchedulesByCategory(
  rows: readonly DepreciationScheduleRow[],
): Map<number, CategoryAmount> {
  const categoryAmounts = new Map<number, CategoryAmount>();
  for (const row of rows) {
    const catId = row.category.id;
    const entry = categoryAmounts.get(catId);
    const amount = Number(row.schedule.amount);
    if (entry) {
      entry.total += amount;
      entry.scheduleIds.push(row.schedule.id);
    } else {
      categoryAmounts.set(catId, {
        depExpAccountId: row.category.depreciationExpenseAccountId,
        accumDepAccountId: row.category.accumulatedDepreciationAccountId,
        total: amount,
        scheduleIds: [row.schedule.id],
      });
    }
  }
  return categoryAmounts;
}

export function categoryAccountIds(categoryAmounts: Map<number, CategoryAmount>): number[] {
  return [
    ...new Set(
      Array.from(categoryAmounts.values()).flatMap((c) => [c.depExpAccountId, c.accumDepAccountId]),
    ),
  ];
}

export function buildDepreciationLines(
  categoryAmounts: Map<number, CategoryAmount>,
  codeMap: ReadonlyMap<number, string>,
  periodKey: string,
): { lines: DraftLine[]; totalAmount: number } {
  const lines: DraftLine[] = [];
  let totalAmount = 0;

  for (const cat of categoryAmounts.values()) {
    const depExpCode = codeMap.get(cat.depExpAccountId);
    const accumDepCode = codeMap.get(cat.accumDepAccountId);
    if (!depExpCode || !accumDepCode) {
      throw new UnprocessableEntityException(
        "Depreciation expense or accumulated depreciation account not found in CoA",
      );
    }
    const amt = roundAmount(cat.total);
    totalAmount += amt;
    lines.push({
      accountCode: depExpCode,
      debit: amt,
      credit: 0,
      description: `Depreciation for ${periodKey}`,
    });
    lines.push({
      accountCode: accumDepCode,
      debit: 0,
      credit: amt,
      description: `Accumulated depreciation for ${periodKey}`,
    });
  }

  return { lines, totalAmount: roundAmount(totalAmount) };
}

/**
 * One row per asset for the `UPDATE … FROM (VALUES …)` register write. The
 * per-asset accumulated figure differs, so this cannot collapse into an
 * `inArray` set; an asset whose accumulated depreciation reaches its depreciable
 * base (cost less salvage) flips to FULLY_DEPRECIATED in the same statement.
 */
export function buildAssetAccumulationRows(
  rows: readonly DepreciationScheduleRow[],
): BulkUpdateRow[] {
  const assetAmounts = new Map<number, number>();
  for (const row of rows) {
    const prev = assetAmounts.get(row.asset.id) ?? 0;
    assetAmounts.set(row.asset.id, prev + Number(row.schedule.amount));
  }

  const assetRows: BulkUpdateRow[] = [];
  for (const [assetId, amt] of assetAmounts) {
    const asset = rows.find((r) => r.asset.id === assetId)?.asset;
    if (!asset) continue;
    const newAccum = roundAmount(Number(asset.accumulatedDepreciation) + amt);
    const depreciable = Number(asset.acquisitionCost) - Number(asset.salvageValue);
    assetRows.push({
      key: assetId,
      values: [
        String(newAccum),
        newAccum >= depreciable - 1 / SCALE ? "FULLY_DEPRECIATED" : "ACTIVE",
      ],
    });
  }
  return assetRows;
}
