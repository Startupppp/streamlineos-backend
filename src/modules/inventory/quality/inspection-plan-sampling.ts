import { cmpDec, divDec, mulDec } from "../stock-engine/decimal";

export type SamplingMethod = "ALL" | "PERCENTAGE" | "FIXED_QUANTITY";

/**
 * D3 — how many units of an arriving quantity an inspector has to open.
 *
 * Never `parseFloat`. Quantities here are `numeric(18,4)` and the module has
 * already been bitten twice by float arithmetic on them (`quality-recalls`, and
 * the GRN quantity comparison B1 replaced), so the percentage is taken with the
 * exact decimal helpers and the rounding is done on the string.
 *
 * Rounding is **up**, and to a whole unit. Ten percent of seven is 0.7, and
 * there is no such thing as inspecting seven tenths of a box; rounding down
 * would make every sampling plan on a small delivery resolve to zero units and
 * silently inspect nothing.
 */
export function resolveSampleQuantity(
  method: SamplingMethod,
  sampleValue: string | null,
  receivedQuantity: string,
): string {
  if (method === "ALL" || sampleValue === null) return receivedQuantity;

  const raw =
    method === "PERCENTAGE"
      ? mulDec(receivedQuantity, divDec(sampleValue, "100"))
      : sampleValue;

  const ceiled = ceilToWholeUnits(raw);
  // A sample is drawn from what arrived: asking for twelve when eight turned up
  // is a rule the delivery cannot satisfy.
  if (cmpDec(ceiled, receivedQuantity) > 0) return receivedQuantity;
  // A plan that resolves to nothing inspects nothing, which is the one answer a
  // required inspection may not give.
  if (cmpDec(ceiled, "0") <= 0) return cmpDec(receivedQuantity, "1") < 0 ? receivedQuantity : "1.0000";
  return ceiled;
}

/** String arithmetic on purpose — `Math.ceil` would take the value through a float. */
function ceilToWholeUnits(value: string): string {
  const [integerPart = "0", fraction = ""] = value.split(".");
  const hasFraction = /[1-9]/.test(fraction);
  const whole = hasFraction ? (BigInt(integerPart) + 1n).toString() : integerPart;
  return `${whole}.0000`;
}
