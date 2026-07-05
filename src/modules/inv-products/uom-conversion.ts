export function convertUomQty(
  qty: number,
  fromRatioToBase: string,
  fromRounding: number,
  toRatioToBase: string,
  toRounding: number,
): number {
  const from = parseFloat(fromRatioToBase);
  const to = parseFloat(toRatioToBase);
  const result = (qty * from) / to;
  const factor = Math.pow(10, toRounding);
  return Math.round(result * factor) / factor;
}
