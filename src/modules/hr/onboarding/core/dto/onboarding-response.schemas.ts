import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../../common/openapi/wire-types";
import { successSchema } from "../../../../../common/openapi/response-envelopes";

// ── Admin progress ─────────────────────────────────────────────────────────────

export const onboardingProgressItemSchema = z.object({
  userId: z.string().nullable(),
  userName: z.string(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  percentComplete: z.number().int(),
  lastCompletedAt: z.string().nullable(),
});

export const onboardingProgressListSchema = z.array(onboardingProgressItemSchema);

export const onboardingInitiateResponseSchema = z.object({
  success: z.literal(true),
  tasksCreated: z.number().int(),
});

export const onboardingReminderResponseSchema = z.object({
  sent: z.number().int(),
  total: z.number().int(),
});

export const ensureDocumentTypesResponseSchema = z.object({
  countryCode: z.string(),
  seeded: z.number().int(),
});

// ── Tasks ──────────────────────────────────────────────────────────────────────

export const onboardingTaskSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  orgId: z.string(),
  templateStepId: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  ownerRole: z.string(),
  dueDate: nullableWireDate(),
  status: z.string(),
  completedAt: nullableWireDate(),
  completedBy: z.string().nullable(),
  dependsOnTaskIds: z.array(z.number().int()).nullable(),
  rowVersion: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  updatedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  canComplete: z.boolean(),
});

export const onboardingTaskListSchema = z.array(onboardingTaskSchema);

// ── Templates ──────────────────────────────────────────────────────────────────

const onboardingTemplateStepSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  ownerRole: z.string(),
  dueOffsetDays: z.number().int(),
  isRequired: z.boolean(),
  isComplianceItem: z.boolean(),
  sortOrder: z.number().int(),
});

export const onboardingTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  departmentId: z.string().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  steps: z.array(onboardingTemplateStepSchema),
});

export const onboardingTemplateListSchema = z.array(onboardingTemplateSchema);

export const onboardingTemplateDepartmentListSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
);

export const createTemplateResponseSchema = z.object({
  success: z.literal(true),
  templateId: z.number().int(),
});

// ── Onboarding session ─────────────────────────────────────────────────────────

export const onboardingFlowSessionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  membershipId: z.number().int().nullable(),
  type: z.string(),
  status: z.string(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  skippedSteps: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  source: z.string().nullable(),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  lastSeenAt: wireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ── Module checklists ──────────────────────────────────────────────────────────

const checklistItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  checklistId: z.number().int(),
  itemKey: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  actionHref: z.string().nullable(),
  status: z.string(),
  required: z.boolean(),
  sortOrder: z.number().int(),
  completedAt: nullableWireDate(),
  skippedAt: nullableWireDate(),
});

export const moduleChecklistSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  moduleKey: z.string(),
  status: z.string(),
  progress: z.number().int(),
  dismissedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  items: z.array(checklistItemSchema),
});

export const moduleChecklistRowSchema = moduleChecklistSchema.omit({ items: true });

export const moduleChecklistListSchema = z.array(moduleChecklistSchema);

export const checklistProgressSchema = z.object({
  progress: z.number().int(),
  status: z.string(),
  requiredIncomplete: z.boolean(),
});

// ── Guided tours ───────────────────────────────────────────────────────────────

export const tourProgressRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  membershipId: z.number().int().nullable(),
  tourKey: z.string(),
  status: z.string(),
  currentStep: z.number().int(),
  completedAt: nullableWireDate(),
  dismissedAt: nullableWireDate(),
  updatedAt: wireDate(),
});

const guidedTourSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  tourKey: z.string(),
  moduleKey: z.string().nullable(),
  role: z.string().nullable(),
  steps: z.array(z.record(z.string(), z.unknown())),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  progress: tourProgressRowSchema.nullable(),
});

export const guidedTourListSchema = z.array(guidedTourSchema);

// ── Personal / bank details ────────────────────────────────────────────────────

export const personalDetailsResponseSchema = z.object({
  phone: z.string().nullable(),
  gender: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressPostalCode: z.string().nullable(),
  addressCountry: z.string().nullable(),
  emergencyName: z.string().nullable(),
  emergencyRelation: z.string().nullable(),
  emergencyPhone: z.string().nullable(),
});

export const bankDetailsResponseSchema = z.object({
  countryCode: z.string(),
  accountHolder: z.string(),
  bankName: z.string(),
  accountNumber: z.string(),
  routingCode: z.string(),
  iban: z.string(),
  swift: z.string(),
  statutory: z.record(z.string(), z.string()),
});

export const onboardingStatusSchema = z.object({
  personalDetails: z.boolean(),
  bankDetails: z.boolean(),
  documents: z.number().int(),
  submitted: z.boolean(),
});

// ── Requirements ───────────────────────────────────────────────────────────────

export const countryRequirementsSchema = z.object({
  countryCode: z.string(),
  bankScheme: z.string(),
  bankFields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    placeholder: z.string(),
    required: z.boolean(),
    uppercase: z.boolean().optional(),
    help: z.string().optional(),
  })),
  statutoryFields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    placeholder: z.string(),
    required: z.boolean(),
    uppercase: z.boolean().optional(),
    help: z.string().optional(),
    pattern: z.string().optional(),
    patternMessage: z.string().optional(),
  })),
  documents: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    isMandatory: z.boolean(),
  })),
});

export { successSchema };
