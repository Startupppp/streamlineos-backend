import { z } from "zod";

/** The platform ceiling: no request may ask for more than this, public included. */
export const PAGE_SIZE_CAP = 100;

export const pageNumberField = z.coerce.number().int().min(1).default(1);

/**
 * Page size, clamped rather than rejected.
 *
 * `.max(100)` answered an over-large request with a 400, so a bookmarked link or
 * a client that remembered the wrong number failed outright instead of getting a
 * page. Clamping gives the caller the largest page they are allowed, which is
 * what they wanted; the cap is still absolute.
 *
 * `maxSize` is for an endpoint that wants a *tighter* ceiling than the platform
 * one — a heavy row, a wide projection. It can only narrow: the platform cap
 * still applies above it.
 */
export function pageSizeField(defaultSize = 50, maxSize = PAGE_SIZE_CAP) {
  const ceiling = Math.min(maxSize, PAGE_SIZE_CAP);
  return z.coerce
    .number()
    .int()
    .min(1)
    .default(Math.min(defaultSize, ceiling))
    .transform((v) => Math.min(v, ceiling));
}

// For an endpoint whose default lives at the call site: same clamp, same cap, but the absent case stays `undefined`.
export function optionalPageSizeField(maxSize = PAGE_SIZE_CAP) {
  const ceiling = Math.min(maxSize, PAGE_SIZE_CAP);
  return z.coerce
    .number()
    .int()
    .min(1)
    .transform((v) => Math.min(v, ceiling))
    .optional();
}

export function optionalPageNumberField() {
  return z.coerce.number().int().min(1).optional();
}

export const baseListQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50),
  cursor: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export type BaseListQuery = z.infer<typeof baseListQuerySchema>;

export function withSortField<const T extends [string, ...string[]]>(
  sortFields: T,
) {
  return baseListQuerySchema.extend({
    sortField: z.enum(sortFields).optional(),
  });
}
