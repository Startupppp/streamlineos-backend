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
}).strict();

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
}).strict();

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
}).strict();

export const createContactSchema = z.object({
  partyId: z.string().uuid(),
  firstName: z.string().min(1).max(255),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
}).strict();

export const updateContactSchema = z.object({
  firstName: z.string().min(1).max(255).optional(),
  lastName: z.string().max(255).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  title: z.string().max(255).nullish(),
  isPrimary: z.boolean().optional(),
}).strict();

/**
 * The role a party holds.
 *
 * Free-form on purpose — CUSTOMER, VENDOR, PARTNER, PROSPECT and whatever a
 * tenant adds — so this constrains shape rather than vocabulary. It exists
 * because `party_roles.role` is NOT NULL and `PartyMergeController.addRole`
 * had no schema between the wire and the insert: a body that named no role
 * reached Drizzle as `undefined`, the column constraint decided the outcome,
 * and the caller got a 500 saying the server was broken when what happened
 * was that they left out a field.
 *
 * Trimmed because the upsert targets `(organization_id, party_id, role)`, so
 * `" CUSTOMER"` and `"CUSTOMER"` would otherwise be two roles on one party
 * that render identically.
 */
export const partyRoleSchema = z
  .object({ role: z.string().trim().min(1).max(255) })
  .strict();

/**
 * The two records a merge fuses.
 *
 * Same reason: `merge` took a bare object literal, so a body missing one side
 * reached `load()` as `undefined` and failed inside the query builder. The
 * service still owns every decision that matters — same-party, cross-tenant,
 * which of the two survives — and this only ensures it is asked a question it
 * can answer.
 */
export const partyMergeSchema = z
  .object({
    leftPartyId: z.string().uuid(),
    rightPartyId: z.string().uuid(),
    /**
     * Which of the two the caller chose to keep.
     *
     * Optional because an unattended merge has nobody to ask, and `merge` then
     * falls back to `chooseSurvivor` — which keeps the older record, the right
     * default for a decision nobody made. It is the wrong answer the moment
     * somebody did: `planMerge` resolves every field conflict in the survivor's
     * favour, so keeping the other one hands a stale stub's name and domain to
     * the record the user was looking straight at, and reports success. This
     * route had no way to say it at all, so the merge dialog's whole question
     * was unanswerable over HTTP; `CrmOrganizationsService.mergeOrganizations`
     * has always passed it on the service call.
     *
     * `merge` rejects a value naming neither party rather than ignoring it.
     */
    preferSurvivorPartyId: z.string().uuid().optional(),
  })
  .strict();

/** The merge ledger's scan window; see `listMerges`. */
export const partyMergeListQuerySchema = z
  .object({
    page: pageNumberField,
    limit: pageSizeField(20, 100),
    /**
     * Reverted merges are hidden by default.
     *
     * The list exists so a merge can be undone after the toast is gone, and one
     * already undone is not an action — it is history. `true` shows both, for
     * the reader asking what happened to a record rather than what they can
     * still take back.
     */
    includeReverted: z.coerce.boolean().default(false),
  })
  .strict();

/** The duplicate queue's scan window; see `listCandidates`. */
export const partyDuplicateQuerySchema = z
  .object({
    page: pageNumberField,
    limit: pageSizeField(20, 100),
    status: z.enum(["PENDING", "MERGED", "DISMISSED"]).default("PENDING"),
  })
  .strict();

export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;
export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type PartyRoleInput = z.infer<typeof partyRoleSchema>;
export type PartyMergeInput = z.infer<typeof partyMergeSchema>;
export type PartyMergeListQuery = z.infer<typeof partyMergeListQuerySchema>;
export type PartyDuplicateQuery = z.infer<typeof partyDuplicateQuerySchema>;
