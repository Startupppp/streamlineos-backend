import { z } from "zod";
import {
  IMPLAUSIBLE_PHONE_MESSAGE,
  isImplausiblePhone,
} from "../../../../common/validation/implausible-phone";
import { ORG_MEMBER_ROLES, ORG_MEMBER_ROLE_VALUES } from "../../../../common/rbac/org-roles";
import { canonicalEmailSchema } from "../../../users/dto/users.schemas";

export const ORG_MODULE_KEYS = [
  "hr",
  "crm",
  "build",
  "accounting",
  "inventory",
  "kb",
  "chat",
  "support",
  "surveys",
  "payroll",
  "sign",
  "timesheets",
] as const;

/**
 * Bounded well below `bulkInviteSchema`'s 500 on purpose. These invitations are sent by
 * `OrgSetupCompletedConsumerService` inside the outbox delivery transaction, which carries a hard
 * wall-clock deadline; a 500-row loop would be abandoned mid-way and re-send on retry. The wizard
 * adds invitees one at a time — bulk import is `POST /users/bulk-invite`, which is not deadline-bound.
 */
export const MAX_SETUP_INVITEES = 50;

export const setupInviteeSchema = z
  .object({
    email: canonicalEmailSchema,
    role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
  })
  .strict();

export type SetupInvitee = z.infer<typeof setupInviteeSchema>;

export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  // HRMS-E2E-025. The owner appeared everywhere as the local part of their
  // sign-up address, because nothing ever asked for their name: sign-up takes an
  // address, and this wizard took the company's name, industry, size and phone
  // but never the person's. Optional, because the schema is already live and
  // making it required would 400 every client that has not shipped the field.
  fullName: z.string().trim().min(1).max(120).optional(),
  industry: z.string().min(1, "Industry is required").max(100),
  companySize: z.string().min(1, "Company size is required").max(50),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  // Optional here, and it always was — the wizard is what insists on it. What it
  // never did was refuse a placeholder: 9999999999 satisfies every shape rule an
  // Indian mobile has, so QA typed it and the organisation ended up carrying a
  // contact nobody answers. This is not verification; the product sends no OTP
  // here. It is the cheap half.
  phone: z
    .string()
    .max(32)
    .refine((value) => !isImplausiblePhone(value), IMPLAUSIBLE_PHONE_MESSAGE)
    .optional(),
  enabledModules: z
    .array(z.enum(ORG_MODULE_KEYS))
    .min(1, "At least one module is required")
    .max(50),
  invitees: z.array(setupInviteeSchema).max(MAX_SETUP_INVITEES).optional(),
}).strict();

export type SetupInput = z.infer<typeof setupSchema>;
