import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";

const projectModulesSchema = z.object({
  sprints: z.boolean(),
  epics: z.boolean(),
  timeTracking: z.boolean(),
  wiki: z.boolean(),
});

export const projectPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

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

export const listProjectsSchema = z.object({
  search: z.string().optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED", "ALL"]).default("ALL"),
  afterId: idCursorSchema,
  limit: pageSizeField(9),
  pmWorkspaceId: z.string().optional(),
  managedProductId: z.coerce.number().int().positive().optional(),
}).strict();

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
    pmWorkspaceId: z.string().optional(),
    managedProductId: z.number().int().positive().optional(),
  }).strict()
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
  }).strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const updateBudgetSchema = z.object({
  budget: z.number().min(0),
}).strict();

export const fromDealSchema = z
  .object({
    dealId: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.string().default("CONTRIBUTOR"),
}).strict();

export const removeMemberSchema = z.object({
  userId: z.string().min(1),
}).strict();

export const updateProjectMemberRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
}).strict();

export type UpdateProjectMemberRoleInput = z.infer<
  typeof updateProjectMemberRoleSchema
>;

export const linkManagedProductSchema = z.object({
  managedProductId: z.number().int().positive().nullable(),
}).strict();

export type ListProjectsInput = z.infer<typeof listProjectsSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
export type FromDealInput = z.infer<typeof fromDealSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;
export type LinkManagedProductInput = z.infer<typeof linkManagedProductSchema>;
