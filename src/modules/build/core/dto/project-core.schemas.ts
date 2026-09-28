import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";
import { invoiceLineDetailEnum } from "../../../../db/schema";

export const listProjectMembersQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(25),
  })
  .strict();
export type ListProjectMembersQuery = z.infer<
  typeof listProjectMembersQuerySchema
>;

export const invoiceLineDetailSchema = z.enum(invoiceLineDetailEnum.enumValues);

export const projectInvoiceLineDetailSchema = z
  .object({
    projectId: z.number().int(),
    invoiceLineDetail: invoiceLineDetailSchema,
  })
  .strict();

const projectModulesSchema = z.object({
  sprints: z.boolean(),
  epics: z.boolean(),
  timeTracking: z.boolean(),
  wiki: z.boolean(),
});

export const projectPrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
]);

export function refineEndAfterStart(
  data: { startDate?: string | null; endDate?: string | null },
  ctx: z.RefinementCtx,
  message = "End date must be after start date",
): void {
  const start = data.startDate;
  const end = data.endDate;
  if (!start || !end) return;
  if (end <= start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path: ["endDate"],
    });
  }
}

export function refineDueOnOrAfterStart(
  data: { startDate?: string | null; dueDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  const start = data.startDate;
  const due = data.dueDate;
  if (!start || !due) return;
  if (due < start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Due date must be on or after start date",
      path: ["dueDate"],
    });
  }
}

export function refineDueDateRange(
  data: { dueDateFrom?: string; dueDateTo?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    !data.dueDateFrom ||
    !data.dueDateTo ||
    data.dueDateTo >= data.dueDateFrom
  )
    return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Due date end must be on or after due date start",
    path: ["dueDateTo"],
  });
}

export const projectHealthEnum = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealthEnum)[number];

export const projectSortEnum = [
  "name_asc",
  "priority_desc",
  "due_asc",
  "due_desc",
] as const;
export type ProjectSort = (typeof projectSortEnum)[number];

export const listProjectsSchema = z
  .object({
    search: z.string().optional(),
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED", "ALL"]).default("ALL"),
    afterId: idCursorSchema,
    afterSortValue: z.string().optional(),
    limit: pageSizeField(9),
    managedProductId: z.coerce.number().int().positive().optional(),
    managerId: z.string().optional(),
    health: z.enum(projectHealthEnum).optional(),
    sort: z.enum(projectSortEnum).optional(),
  })
  .strict();

export const createProjectSchema = z
  .object({
    name: z
      .string()
      .min(2, "Project name must be at least 2 characters")
      .max(100, "Project name must be 100 characters or fewer")
      .trim()
      .refine((v) => v.trim().length > 0, {
        message: "Project name cannot be blank",
      }),
    description: z
      .string()
      .max(2000, "Description must be 2000 characters or fewer")
      .optional(),
    key: z
      .string()
      .min(2, "Project key must be at least 2 characters")
      .max(10, "Project key must be 10 characters or fewer")
      .regex(
        /^[A-Z][A-Z0-9]*$/,
        "Key must start with a letter and contain only uppercase letters/numbers",
      )
      .optional(),
    managerId: z.string().optional(),
    clientId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    memberIds: z.array(z.string()).max(100).optional(),
    modules: projectModulesSchema.optional(),
    projectType: z.string().optional(),
    workflow: z.string().optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    priority: projectPrioritySchema.optional(),
    managedProductId: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
    managerId: z.string().nullable().optional(),
    clientId: z.string().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    memberIds: z.array(z.string()).max(100).optional(),
    reassignments: z.record(z.string(), z.string()).optional(),
    projectType: z.string().optional(),
    workflow: z.string().optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    priority: projectPrioritySchema.optional(),
    invoiceLineDetail: invoiceLineDetailSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const updateBudgetSchema = z
  .object({
    budget: z.number().min(0),
  })
  .strict();

export const fromDealSchema = z
  .object({
    dealId: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const addMemberSchema = z
  .object({
    userId: z.string().min(1),
    role: z.string().default("CONTRIBUTOR"),
  })
  .strict();

export const removeMemberSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

export const updateProjectMemberRoleSchema = z
  .object({
    role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
  })
  .strict();

export type UpdateProjectMemberRoleInput = z.infer<
  typeof updateProjectMemberRoleSchema
>;

export const linkManagedProductSchema = z
  .object({
    managedProductId: z.number().int().positive().nullable(),
  })
  .strict();

export type ListProjectsInput = z.infer<typeof listProjectsSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
export type FromDealInput = z.infer<typeof fromDealSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;
export type LinkManagedProductInput = z.infer<typeof linkManagedProductSchema>;
export type ProjectInvoiceLineDetail = z.infer<
  typeof projectInvoiceLineDetailSchema
>;
