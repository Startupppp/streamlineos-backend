import { allocateDecimal, decimalFromNumber } from "./money.util";

export const ACCOUNT_CODES = {
  cash: "1000",
  bank: "1100",
  accountsReceivable: "1200",
  outputCgst: "2110",
  outputSgst: "2111",
  outputIgst: "2112",
  salesRevenue: "4000",
  serviceRevenue: "4100",
} as const;

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

interface GstContext {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
}

function isIntraState(ctx: GstContext): boolean {
  return ctx.supplierStateCode === ctx.placeOfSupplyStateCode;
}

/**
 * The two halves are allocated rather than each rounded, so `cgst + sgst` is the
 * pool to the last paisa and the journal the caller builds from them balances.
 */
export function splitTaxPool(taxPool: number, ctx: GstContext): GstSplit {
  const pool = decimalFromNumber(taxPool);
  if (isIntraState(ctx)) {
    const [cgst, sgst] = allocateDecimal(pool, ["1", "1"]);
    return { cgst: Number(cgst), sgst: Number(sgst), igst: 0, total: Number(pool) };
  }
  return { cgst: 0, sgst: 0, igst: Number(pool), total: Number(pool) };
}

export function paymentMethodToAccountCode(method: string): "1000" | "1100" {
  return method === "cash" ? "1000" : "1100";
}
