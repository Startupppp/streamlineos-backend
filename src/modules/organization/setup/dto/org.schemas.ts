import { z } from "zod";
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
const MAX_SETUP_INVITEES = 50;

export const setupInviteeSchema = z
  .object({
    email: canonicalEmailSchema,
    role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
  })
  .strict();

export type SetupInvitee = z.infer<typeof setupInviteeSchema>;

export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  industry: z.string().min(1, "Industry is required").max(100),
  companySize: z.string().min(1, "Company size is required").max(50),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  enabledModules: z
    .array(z.enum(ORG_MODULE_KEYS))
    .min(1, "At least one module is required")
    .max(50),
  invitees: z.array(setupInviteeSchema).max(MAX_SETUP_INVITEES).optional(),
}).strict();

export type SetupInput = z.infer<typeof setupSchema>;
