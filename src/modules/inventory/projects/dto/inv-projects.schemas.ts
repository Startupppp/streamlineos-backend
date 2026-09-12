import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const PROJECT_CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;
const SAFE_TEXT_RE = /^[\p{L}\p{N}\s\-.,#/()'&]+$/u;
const DECIMAL_PATTERN = /^\d+(\.\d{1,4})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** E.164-ish, plus the plain ten digits an Indian site contact is written as. */
const PHONE_RE = /^\+?[0-9][0-9\s-]{6,19}$/;

export const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
export const REQUIREMENT_STATUSES = [
  "DRAFT", "REQUESTED", "RESERVED", "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED",
] as const;

const isoDate = z
  .string()
  .trim()
  .regex(ISO_DATE_RE, "Date must be YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Not a real date");

const projectFields = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Project code must be at least 2 characters")
    .max(30, "Project code must be 30 characters or fewer")
    .regex(PROJECT_CODE_RE, "Code must be uppercase letters, digits, hyphens or underscores (e.g. HYD-TOWER-04)")
    .transform((v) => v.toUpperCase()),
  name: z
    .string()
    .trim()
    .min(2, "Project name is required")
    .max(160, "Name must be 160 characters or fewer")
    .regex(SAFE_TEXT_RE, "Name contains unsupported characters"),
  clientId: z.number().int().positive().nullable().optional(),
  siteAddress: z.string().trim().max(255).regex(SAFE_TEXT_RE, "Address contains unsupported characters").nullable().optional(),
  city: z.string().trim().max(80).regex(SAFE_TEXT_RE, "City contains unsupported characters").nullable().optional(),
  zone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/, "Zone must be uppercase letters, digits, hyphens or underscores (e.g. HYD_NORTH)")
    .nullable()
    .optional(),
  siteContactName: z.string().trim().max(120).regex(SAFE_TEXT_RE, "Contact name contains unsupported characters").nullable().optional(),
  siteContactPhone: z.string().trim().regex(PHONE_RE, "Enter a valid phone number").nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startsOn: isoDate.nullable().optional(),
  endsOn: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

/**
 * The dates are checked as a pair, on both shapes. A PATCH that moves only one
 * of them is checked against the stored other in the service — the schema can
 * only see what was sent, and half a rule enforced here would read as the whole
 * rule to the next person.
 */
const datesInOrder = (v: { startsOn?: string | null; endsOn?: string | null }) =>
  !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn;
const datesMessage = { message: "A project cannot end before it starts", path: ["endsOn"] };

export const createProjectSchema = projectFields.refine(datesInOrder, datesMessage);
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = projectFields.partial().refine(datesInOrder, datesMessage);
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsSchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  zone: z.string().trim().max(40).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  /** Open work only — everything that is not COMPLETED or CANCELLED. */
  openOnly: z.coerce.boolean().optional(),
  page: pageNumberField,
  limit: pageSizeField(25, 100),
}).strict();
export type ListProjectsInput = z.infer<typeof listProjectsSchema>;

export const createRequirementSchema = z.object({
  productVariantId: z.number().int().positive(),
  warehouseId: z.number().int().positive().nullable().optional(),
  requiredQty: z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, "Quantity must be a decimal with up to 4 places")
    .refine((v) => Number(v) > 0, "Quantity must be greater than zero"),
  requiredBy: isoDate.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

export const updateRequirementSchema = z.object({
  warehouseId: z.number().int().positive().nullable().optional(),
  requiredQty: z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, "Quantity must be a decimal with up to 4 places")
    .refine((v) => Number(v) > 0, "Quantity must be greater than zero")
    .optional(),
  requiredBy: isoDate.nullable().optional(),
  /**
   * `RESERVED`, `PARTIALLY_FULFILLED` and `FULFILLED` are not settable by hand:
   * they are what reserving and dispatching make true, and a hand-set one would
   * claim stock is held that nothing is holding.
   */
  status: z.enum(["DRAFT", "REQUESTED", "CANCELLED"]).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

/**
 * B1 — reserve stock against one requirement.
 *
 * The quantity is optional: the common case is "hold what this line asks for",
 * and making the caller restate it invites the two to disagree. When it is
 * given it may not exceed what is still outstanding on the line.
 */
export const reserveRequirementSchema = z.object({
  qty: z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, "Quantity must be a decimal with up to 4 places")
    .refine((v) => Number(v) > 0, "Quantity must be greater than zero")
    .optional(),
  warehouseId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  /**
   * When the hold lapses if nothing is dispatched against it. A reservation with
   * no expiry on a site that slipped is stock nobody can sell and nobody is
   * using — which is how a warehouse ends up full and empty at the same time.
   */
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ReserveRequirementInput = z.infer<typeof reserveRequirementSchema>;
