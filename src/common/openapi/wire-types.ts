import { z } from "zod";

/**
 * A field the HANDLER returns as a `Date` and the WIRE carries as an ISO string.
 *
 * `@ResponseSchema` has two readers that disagree about when they look at the value.
 * `ResponseContractInterceptor` sees what the handler returned — a `Date` object,
 * because `JSON.stringify` has not run yet — so the schema must accept `Date` or every
 * timestamp field reports a false violation. `build-openapi-document` publishes what an
 * external consumer receives — a string — so the JSON Schema must say
 * `string/date-time` or the document is wrong about the field's type.
 *
 * `z.date()` alone satisfies the first and fails the second: `z.toJSONSchema` with
 * `unrepresentable: "any"` emits `{}` for it, which is a field with no declared type at
 * all — and `{}` is exactly the kind of vacuously-satisfied schema that makes a
 * coverage number lie. `.meta()` is registered metadata that `z.toJSONSchema` merges,
 * so one declaration answers both readers: runtime `Date`, published `string/date-time`.
 *
 * Verified against zod 4.4.3 in `wire-types.spec.ts` — both halves, so an upgrade that
 * changed either behaviour fails rather than silently emitting `{}` again.
 */
export function wireDate(): z.ZodType<Date> {
  return z.date().meta({ type: "string", format: "date-time" });
}

/**
 * `wireDate()` for a column that is genuinely nullable.
 *
 * The metadata sits on the INNER date, not on the nullable wrapper: registered on the
 * wrapper it is merged alongside the generated `anyOf` rather than into it, producing
 * an entry that says both `anyOf: [{}, {type:"null"}]` and `type: ["string","null"]` —
 * two contradictory declarations of the same field. On the inner type it produces the
 * one correct `anyOf: [{type:"string",format:"date-time"}, {type:"null"}]`.
 */
export function nullableWireDate(): z.ZodType<Date | null> {
  return wireDate().nullable();
}

export function wireTimestamp(): z.ZodType<Date | string> {
  return z.union([wireDate(), z.iso.datetime()]);
}

export function nullableWireTimestamp(): z.ZodType<Date | string | null> {
  return wireTimestamp().nullable();
}
