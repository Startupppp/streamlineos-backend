import type { sql } from "drizzle-orm";
import type { Db } from "../../../../../db/drizzle.module";
import type { ResolvedWarehouseScope } from "../../../stock-engine/warehouse-scope.service";
import type { InvEvidenceReference } from "../../dto/inv-ai-contract";

export type InvCopilotCell = string | number | null;

export interface InvCopilotToolContext {
  db: Db;
  orgId: string;
  scope: ResolvedWarehouseScope;
  focus: {
    variantId?: number | undefined;
    warehouseId?: number | undefined;
    vendorId?: number | undefined;
  };
}

export interface ToolDefinition {
  label: string;
  /** Shown to the model when it chooses. Static text from this file only. */
  description: string;
  columns: readonly string[];
  run: (ctx: InvCopilotToolContext) => Promise<{
    rows: Array<Record<string, InvCopilotCell>>;
    evidence: InvEvidenceReference[];
    truncated: boolean;
  }>;
}

export const COPILOT_ROW_CAP = 20;
export const COPILOT_TEXT_CAP = 120;

/**
 * The shaping helpers every copilot tool uses, split out of
 * `inv-copilot-tools.ts` so the tool table can live in more than one file.
 */
/** Bound a tenant string on the way into a result. */
export function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length > COPILOT_TEXT_CAP ? `${value.slice(0, COPILOT_TEXT_CAP)}…` : value;
}

/** Read one page past the cap so "there are more" is a fact, not a guess. */
export function takeCapped<T>(rows: T[]): { page: T[]; truncated: boolean } {
  return rows.length > COPILOT_ROW_CAP
    ? { page: rows.slice(0, COPILOT_ROW_CAP), truncated: true }
    : { page: rows, truncated: false };
}

/** Collect distinct evidence references, dropping anything without a real id. */
export function evidenceFrom(
  entries: ReadonlyArray<[InvEvidenceReference["kind"], number | null | undefined]>,
): InvEvidenceReference[] {
  const seen = new Set<string>();
  const refs: InvEvidenceReference[] = [];
  for (const [kind, id] of entries) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, id });
  }
  return refs;
}

export const EMPTY = { rows: [], evidence: [], truncated: false } as const;

/**
 * The one place the warehouse gate is expressed for a table keyed by location.
 * `inv_stock_levels` and `inv_stock_transactions` both name a location and not
 * a warehouse, so both go through here rather than each writing the subquery.
 */
export function locationScoped(ctx: InvCopilotToolContext, column: ReturnType<typeof sql>) {
  return ctx.scope.location(column);
}
