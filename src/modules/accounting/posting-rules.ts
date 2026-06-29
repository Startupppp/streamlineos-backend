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

const round2 = (n: number): number => Math.round(n * 100) / 100;

function isIntraState(ctx: GstContext): boolean {
  return ctx.supplierStateCode === ctx.placeOfSupplyStateCode;
}

export function splitTaxPool(taxPool: number, ctx: GstContext): GstSplit {
  if (isIntraState(ctx)) {
    const half = round2(taxPool / 2);
    return { cgst: half, sgst: round2(taxPool - half), igst: 0, total: taxPool };
  }
  return { cgst: 0, sgst: 0, igst: round2(taxPool), total: taxPool };
}

export function paymentMethodToAccountCode(method: string): "1000" | "1100" {
  return method === "cash" ? "1000" : "1100";
}
