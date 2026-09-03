import { z } from "zod";
import { pageSizeField } from "../../common/pagination/list-query.schema";

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  image: z.string().max(500).optional(),
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z.string().max(15).optional(),
  whatsappNumber: z.string().max(15).optional(),
  emergencyContact: z
    .object({
      name: z.string().min(1),
      relation: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional(),
    })
    .optional(),
  bankDetails: z
    .object({
      accountNumber: z.string().min(1),
      bankName: z.string().min(1),
      branch: z.string().min(1),
      ifsc: z.string().min(1),
      accountHolder: z.string().min(1),
      pfUanNumber: z.string().optional(),
    })
    .optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * The query contract for `GET /me/login-history`.
 *
 * The handler used to coerce these by hand — `Number(page)` and
 * `Math.min(Number(limit), 100)` — with no lower clamp and no ceiling on `page`.
 * `?limit=abc` reached Postgres as `LIMIT NaN` (22P02) and `?limit=-5` as a
 * negative LIMIT (2201W), so a malformed query answered 500 instead of 400; and
 * `?page=1e9&limit=100` computed OFFSET 99,999,999,900, an unbounded
 * scan-and-discard on a route every authenticated user can reach.
 *
 * `PAGE_CEILING` is the page number at which the offset stops being a page and
 * starts being a denial-of-service: at the 100-row cap it bounds OFFSET at
 * 99,900. Anything deeper than that is a keyset-pagination question, not a page
 * number, and login history is bounded per user anyway.
 */
const PAGE_CEILING = 1_000;

export const loginHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(PAGE_CEILING).default(1),
    limit: pageSizeField(20, 100),
    success: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  })
  .strict();

export type LoginHistoryQuery = z.infer<typeof loginHistoryQuerySchema>;
