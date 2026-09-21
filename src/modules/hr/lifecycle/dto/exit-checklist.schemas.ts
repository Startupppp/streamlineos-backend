import { z } from "zod";
import { exitChecklistStatusEnum } from "../../../../db/schema/common/enums";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";

export const EXIT_CHECKLIST_KINDS = [
  "manager_handover",
  "hr_clearance",
  "it_access_removal",
  "asset_return",
  "final_settlement",
  "documents",
  "exit_interview",
  "completion_evidence",
] as const;

export type ExitChecklistKind = (typeof EXIT_CHECKLIST_KINDS)[number];

export const EXIT_CHECKLIST_CUSTOM_KIND = "custom" as const;
export const EXIT_CHECKLIST_CUSTOM_KEY_PREFIX = "custom-";

export const EXIT_CHECKLIST_STATUSES = exitChecklistStatusEnum.enumValues;
export type ExitChecklistStatus = (typeof EXIT_CHECKLIST_STATUSES)[number];

export const EXIT_CHECKLIST_QUEUES = {
  "hr:exit:manage": "HR exits queue",
  "hr:identity:manage": "Identity & access queue",
  "hr:assets:manage": "Assets queue",
  "hr:payroll:approve": "Final settlement queue",
} as const;

export type ExitChecklistQueue = keyof typeof EXIT_CHECKLIST_QUEUES;

export const EXIT_CHECKLIST_QUEUE_KEYS = Object.keys(EXIT_CHECKLIST_QUEUES) as [ExitChecklistQueue, ...ExitChecklistQueue[]];

export function isExitChecklistQueue(value: string): value is ExitChecklistQueue {
  return Object.hasOwn(EXIT_CHECKLIST_QUEUES, value);
}

export function isExitChecklistKind(value: string): value is ExitChecklistKind {
  return EXIT_CHECKLIST_KINDS.some((kind) => kind === value);
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date");

export const exitChecklistItemParamsSchema = z
  .object({
    resignationId: z.coerce.number().int().positive(),
    itemKey: z.string().trim().min(1).max(120),
  })
  .strict();

export type ExitChecklistItemParams = z.infer<typeof exitChecklistItemParamsSchema>;

export const exitChecklistItemUpdateSchema = z
  .object({
    status: z.enum(EXIT_CHECKLIST_STATUSES).optional(),
    evidence: z.string().trim().min(1).max(2000).optional(),
    notes: z.string().trim().max(2000).optional(),
    dueDate: isoDay.optional(),
    ownerUserId: z.string().trim().min(1).max(191).optional(),
    ownerQueue: z.enum(EXIT_CHECKLIST_QUEUE_KEYS).optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to update",
  })
  .refine((body) => body.ownerUserId === undefined || body.ownerQueue === undefined, {
    message: "An item is owned by a person or by a queue, not both",
    path: ["ownerQueue"],
  })
  .refine((body) => body.status === undefined || body.status === "PENDING" || body.evidence !== undefined, {
    message: "Closing an item needs completion evidence",
    path: ["evidence"],
  });

export type ExitChecklistItemUpdateInput = z.infer<typeof exitChecklistItemUpdateSchema>;

export const exitChecklistOwnerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("member"),
    membershipId: z.number().int(),
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  z.object({
    type: z.literal("queue"),
    permission: z.enum(EXIT_CHECKLIST_QUEUE_KEYS),
    label: z.string(),
  }),
]);

export type ExitChecklistOwner = z.infer<typeof exitChecklistOwnerSchema>;

export const exitChecklistItemSchema = z.object({
  id: z.number().int(),
  itemKey: z.string(),
  kind: z.enum([...EXIT_CHECKLIST_KINDS, EXIT_CHECKLIST_CUSTOM_KIND]),
  title: z.string(),
  status: z.enum(EXIT_CHECKLIST_STATUSES),
  dueDate: z.string().nullable(),
  owner: exitChecklistOwnerSchema,
  completedAt: nullableWireDate(),
  completedBy: z.object({ membershipId: z.number().int(), name: z.string().nullable() }).nullable(),
  evidence: z.string().nullable(),
  notes: z.string().nullable(),
  updatedAt: wireDate(),
  viewerCanUpdate: z.boolean(),
});

export type ExitChecklistItem = z.infer<typeof exitChecklistItemSchema>;

export const exitChecklistSummarySchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  done: z.number().int(),
  waived: z.number().int(),
  overdue: z.number().int(),
});

export const exitChecklistSchema = z.object({
  items: z.array(exitChecklistItemSchema),
  summary: exitChecklistSummarySchema,
});

export type ExitChecklist = z.infer<typeof exitChecklistSchema>;
