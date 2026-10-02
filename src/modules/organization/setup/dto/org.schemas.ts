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
export const MAX_SETUP_INVITATION_BATCHES = 8;

const setupModuleAccessItemSchema = z
  .object({
    moduleKey: z.enum(ORG_MODULE_KEYS),
    standing: z.enum(["MEMBER", "ADMIN"]),
  })
  .strict();

export const setupModuleAccessSchema = z
  .array(setupModuleAccessItemSchema)
  .max(10)
  .refine(
    (items) => new Set(items.map((item) => item.moduleKey)).size === items.length,
    "moduleAccess must not contain duplicate moduleKey entries",
  );

export type SetupModuleAccess = z.infer<typeof setupModuleAccessSchema>;

export const setupInviteeSchema = z
  .object({
    email: canonicalEmailSchema,
    role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
    moduleAccess: setupModuleAccessSchema.optional(),
  })
  .strict();

export type SetupInvitee = z.infer<typeof setupInviteeSchema>;

export const setupInviteeInputSchema = z
  .object({
    email: canonicalEmailSchema,
    role: z.enum([ORG_MEMBER_ROLES.MEMBER, ORG_MEMBER_ROLES.ORG_ADMIN]).default(ORG_MEMBER_ROLES.MEMBER),
    moduleAccess: setupModuleAccessSchema.optional(),
  })
  .strict();

export function canonicalSetupModuleAccess(
  moduleAccess: readonly SetupModuleAccess[number][],
): SetupModuleAccess {
  return [...moduleAccess].sort((left, right) =>
    left.moduleKey.localeCompare(right.moduleKey),
  );
}

export function newSetupInviteeModuleAccess(
  invitee: SetupInvitee,
  selectedModules: readonly string[],
): SetupModuleAccess | undefined {
  if (invitee.moduleAccess !== undefined) return invitee.moduleAccess;
  if (invitee.role === ORG_MEMBER_ROLES.MEMBER && selectedModules.includes("build"))
    return [{ moduleKey: "build", standing: "MEMBER" }];
  return undefined;
}

export function setupInvitationBatchKey(
  role: string,
  moduleAccess: readonly SetupModuleAccess[number][],
): string {
  return JSON.stringify([
    role,
    canonicalSetupModuleAccess(moduleAccess).map((item) => [item.moduleKey, item.standing]),
  ]);
}

export function validateSetupInviteeAccess(
  invitees: readonly SetupInvitee[],
  selectedModules: readonly string[],
  ctx: z.RefinementCtx,
  applyNewInviteDefaults: boolean,
): void {
  const selected = new Set(selectedModules);
  const batches = new Set<string>();

  invitees.forEach((invitee, inviteeIndex) => {
    const moduleAccess = applyNewInviteDefaults
      ? (newSetupInviteeModuleAccess(invitee, selectedModules) ?? [])
      : (invitee.moduleAccess ?? []);
    moduleAccess.forEach((grant, grantIndex) => {
      if (!selected.has(grant.moduleKey))
        ctx.addIssue({
          code: "custom",
          path: ["invitees", inviteeIndex, "moduleAccess", grantIndex, "moduleKey"],
          message: `Module ${grant.moduleKey} is not selected for this workspace`,
        });
    });
    batches.add(setupInvitationBatchKey(invitee.role, moduleAccess));
  });

  if (batches.size > MAX_SETUP_INVITATION_BATCHES)
    ctx.addIssue({
      code: "custom",
      path: ["invitees"],
      message: `Onboarding supports at most ${MAX_SETUP_INVITATION_BATCHES} distinct invitation access sets; align access for some invitees or invite them after launch`,
    });
}

export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  // HRMS-E2E-025. The owner appeared everywhere as the local part of their
  // sign-up address, because nothing ever asked for their name: sign-up takes an
  // address, and this wizard took the company's name, industry, size and phone
  // but never the person's.
  //
  // V-023: required on the server too. It was optional here while only the
  // wizard enforced it, which means "required" was a client-side courtesy —
  // any other caller of this route could still create an org with no founder
  // name and reproduce the whole defect.
  fullName: z.string().trim().min(1, "Your name is required").max(120),
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
    .max(50)
    .refine(
      (moduleKeys) => new Set(moduleKeys).size === moduleKeys.length,
      "enabledModules must not contain duplicate module keys",
    ),
  invitees: z.array(setupInviteeInputSchema).max(MAX_SETUP_INVITEES).optional(),
}).strict().superRefine((input, ctx) =>
  validateSetupInviteeAccess(input.invitees ?? [], input.enabledModules, ctx, true),
);

export type SetupInput = z.infer<typeof setupSchema>;
