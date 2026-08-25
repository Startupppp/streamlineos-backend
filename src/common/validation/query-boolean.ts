import { z } from "zod";

/**
 * A boolean that survives the query string.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every non-empty string is
 * truthy — so `?activeOnly=false` parses as **true**, and a filter the caller
 * explicitly turned off silently stays on. It is the right tool for a JSON body
 * and the wrong one for a URL, and the two look identical at the call site.
 *
 * This accepts what a query string actually carries — `true/false`, `1/0`,
 * `yes/no`, `on/off`, and a bare `?flag` with no value — as well as a real
 * boolean, so the same schema is correct in a body too. Anything else is a
 * validation error rather than a guess, because a caller who typed `?flag=maybe`
 * deserves a 400 rather than a silent default.
 */
export const queryBoolean = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "boolean") return value;

    switch (value.trim().toLowerCase()) {
      // A bare `?flag` arrives as an empty string and means "on" — that is what
      // writing the flag at all was for.
      case "":
      case "true":
      case "1":
      case "yes":
      case "on":
        return true;
      case "false":
      case "0":
      case "no":
      case "off":
        return false;
      default:
        ctx.addIssue({
          code: "custom",
          message: `Expected a boolean (true/false, 1/0, yes/no, on/off), received "${value}"`,
        });
        return z.NEVER;
    }
  });
