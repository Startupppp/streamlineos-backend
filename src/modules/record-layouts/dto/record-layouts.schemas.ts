import { z } from "zod";
import {
  isHidable,
  RECORD_LAYOUT_KEYS,
  type RecordLayoutDescription,
} from "../record-layout-catalog";

/**
 * The boundary of a tenant's arrangement.
 *
 * The frontend refuses everything below before it ever sends a request. That is
 * a courtesy to the person using the screen, not a control: a direct call to
 * `PUT /renderer/layouts/crm:lead` bypasses every line of it, and an arrangement
 * is stored data that outlives the description it was written against. So the
 * same rules are enforced here, against the published set, and the client's
 * opinion of what a field is called is never consulted.
 *
 * What this cannot be used to do, stated because a validator is exactly where
 * somebody would later add it: hiding is DISPLAY ONLY and must never become a
 * permission. Hiding a field a user is not allowed to read does not make the
 * read succeed, and revealing one does not widen anything — every name accepted
 * here is a name the description already publishes to everybody who can see the
 * record at all.
 */

/** A layout a tenant may arrange. Anything else is not a record type, so 400. */
export const layoutKeySchema = z
  .string()
  .min(1)
  .max(64)
  .refine((key) => RECORD_LAYOUT_KEYS.includes(key), {
    message: `unknown layout; expected one of: ${RECORD_LAYOUT_KEYS.join(", ")}`,
  });

/**
 * Bounds, so a single arrangement cannot be made arbitrarily large.
 *
 * The widest published layout declares 24 fields, so these are far above any
 * honest use and are here to stop a row that has to be read on every record
 * surface in the product from growing without limit.
 */
export const MAX_FIELD_NAMES = 200;
export const MAX_GROUPS = 40;
export const MAX_GROUP_TITLE = 80;

/** Field names are identifiers the description published, not free text. */
const fieldName = z.string().trim().min(1).max(128);

const fieldNames = z.array(fieldName).max(MAX_FIELD_NAMES);

export const layoutGroupSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_GROUP_TITLE),
    fields: fieldNames,
  })
  .strict();

/**
 * `.strict()`, and no `layoutKey` in the body.
 *
 * The key is the path, and the organisation is the caller. A body that could
 * name either would be a second address for one row — which is how a tenant ends
 * up writing another tenant's arrangement.
 */
export const saveLayoutAdjustmentSchema = z
  .object({
    order: fieldNames.optional(),
    hidden: fieldNames.optional(),
    groups: z.array(layoutGroupSchema).max(MAX_GROUPS).optional(),
  })
  .strict();

export type SaveLayoutAdjustmentInput = z.infer<typeof saveLayoutAdjustmentSchema>;

function duplicatesIn(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated];
}

/**
 * The half of validation that needs to know which record type this is.
 *
 * Kept as a zod refinement rather than a pile of `BadRequestException`s so a
 * caller gets every problem at once, each on the path that caused it — an
 * administrator fixing an arrangement should not have to submit it eight times
 * to be told about eight unknown fields.
 */
export function layoutAdjustmentSchemaFor(layout: RecordLayoutDescription) {
  const declared = new Set(layout.fields);

  return saveLayoutAdjustmentSchema.superRefine((value, ctx) => {
    const unknownField = (name: string, path: (string | number)[]): boolean => {
      if (declared.has(name)) return false;
      ctx.addIssue({
        code: "custom",
        path,
        message: `"${name}" is not a field of the ${layout.singular} layout`,
      });
      return true;
    };

    for (const [index, name] of (value.order ?? []).entries())
      unknownField(name, ["order", index]);

    for (const name of duplicatesIn(value.order ?? []))
      ctx.addIssue({
        code: "custom",
        path: ["order"],
        message: `"${name}" is listed twice; an order cannot put one field in two places`,
      });

    for (const [index, name] of (value.hidden ?? []).entries()) {
      if (unknownField(name, ["hidden", index])) continue;
      if (isHidable(layout, name)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["hidden", index],
        message:
          name === layout.titleField
            ? `"${name}" titles the record, so hiding it would leave it unnamed`
            : `"${name}" is required, so hiding it would leave the form unsubmittable`,
      });
    }

    for (const name of duplicatesIn(value.hidden ?? []))
      ctx.addIssue({
        code: "custom",
        path: ["hidden"],
        message: `"${name}" is listed twice`,
      });

    const placed: string[] = [];
    for (const [groupIndex, group] of (value.groups ?? []).entries()) {
      for (const [fieldIndex, name] of group.fields.entries())
        unknownField(name, ["groups", groupIndex, "fields", fieldIndex]);
      placed.push(...group.fields);
    }

    for (const name of duplicatesIn(placed))
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: `"${name}" is placed in more than one group`,
      });
  });
}
