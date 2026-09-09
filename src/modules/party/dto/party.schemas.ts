import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { isKnownTimeZone } from "../../autonomy/working-hours";

const partyTypeValues = ["CUSTOMER", "VENDOR", "PARTNER", "BOTH"] as const;

/**
 * A second axis, not a fifth `party_type`. See `partyKindEnum`: what a party is
 * TO US is `party_type` and `party_roles`; whether it is a person or a company
 * is neither of those and does not change when a prospect becomes a customer.
 */
const partyKindValues = ["PERSON", "ORGANISATION"] as const;

export const listPartiesQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  cursor: z.string().optional(),
  role: z.string().trim().min(1).optional(),
  partyType: z.enum(partyTypeValues).optional(),
  // What the Companies surface filters on: `/crm/organizations` is this list with
  // `partyKind=ORGANISATION`, which is what makes it one list rather than two.
  partyKind: z.enum(partyKindValues).optional(),
  search: z.string().optional(),
});

export const createPartySchema = z.object({
  name: z.string().min(1).max(255),
  partyType: z.enum(partyTypeValues).optional(),
  partyKind: z.enum(partyKindValues).optional(),
  employerPartyId: z.string().uuid().optional(),
  legalName: z.string().max(255).optional(),
  displayName: z.string().max(255).optional(),
  taxNumber: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
});

/**
 * An IANA zone the runtime recognises, or null to say "unknown".
 *
 * Checked against the runtime's own tzdata rather than a hardcoded list, which
 * would rot: zones are added and renamed without a release of this code. Null
 * is a legitimate value and is not the same as omitting the field — one clears
 * a wrong zone, the other leaves it alone.
 */
const ianaTimezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isKnownTimeZone, "Not a time zone this server recognises");

export const updatePartySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  partyType: z.enum(partyTypeValues).optional(),
  partyKind: z.enum(partyKindValues).nullish(),
  employerPartyId: z.string().uuid().nullish(),
  legalName: z.string().max(255).nullish(),
  displayName: z.string().max(255).nullish(),
  taxNumber: z.string().max(100).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  website: z.string().url().nullish(),
  notes: z.string().nullish(),
  status: z.string().max(50).optional(),
  timezone: ianaTimezone.nullish(),
});

export const createContactSchema = z.object({
  partyId: z.string().uuid(),
  firstName: z.string().min(1).max(255),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
});

export const updateContactSchema = z.object({
  firstName: z.string().min(1).max(255).optional(),
  lastName: z.string().max(255).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  title: z.string().max(255).nullish(),
  isPrimary: z.boolean().optional(),
});

/**
 * The mirror check's scan window.
 *
 * `after` resumes a truncated scan of one kind, so it only means anything
 * alongside `kind` -- without one it would silently skip the low ids of all
 * three tables and report a clean mirror it never looked at.
 */
export const mirrorDivergenceQuerySchema = z
  .object({
    kind: z.enum(["LEAD", "CLIENT", "CONTACT", "ORGANISATION"]).optional(),
    limit: pageSizeField(200),
    after: z.coerce.number().int().min(0).default(0),
  })
  .refine((query) => query.after === 0 || query.kind !== undefined, {
    message: "after resumes a single kind's scan and requires kind",
    path: ["after"],
  });

export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;
export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type MirrorDivergenceQuery = z.infer<typeof mirrorDivergenceQuerySchema>;
