import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const paginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
});

export const createAccommodationSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(["equipment", "schedule", "workspace", "medical_restriction", "other"]),
  description: z.string().min(5).max(5000),
  confidentialMedicalNote: z.string().max(10000).optional(),
});

export const updateAccommodationSchema = z.object({
  type: z.enum(["equipment", "schedule", "workspace", "medical_restriction", "other"]).optional(),
  description: z.string().min(5).max(5000).optional(),
  confidentialMedicalNote: z.string().max(10000).nullable().optional(),
  status: z.enum(["requested", "under_review", "approved", "denied", "implemented"]).optional(),
  note: z.string().max(5000).nullable().optional(),
});

export const approveAccommodationSchema = z.object({
  note: z.string().max(5000).optional(),
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    assigneeUserId: z.string().uuid().optional(),
    dueDate: z.string().optional(),
  })).optional(),
});

export const listAccommodationsSchema = paginationSchema.extend({
  userId: z.string().uuid().optional(),
  status: z.enum(["requested", "under_review", "approved", "denied", "implemented"]).optional(),
  type: z.enum(["equipment", "schedule", "workspace", "medical_restriction", "other"]).optional(),
});

export const createAccommodationTaskSchema = z.object({
  title: z.string().min(1).max(500),
  assigneeUserId: z.string().uuid().optional(),
  dueDate: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
});

export const updateAccommodationTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
});

export type CreateAccommodationInput = z.infer<typeof createAccommodationSchema>;
export type UpdateAccommodationInput = z.infer<typeof updateAccommodationSchema>;
export type ApproveAccommodationInput = z.infer<typeof approveAccommodationSchema>;
export type ListAccommodationsInput = z.infer<typeof listAccommodationsSchema>;
export type CreateAccommodationTaskInput = z.infer<typeof createAccommodationTaskSchema>;
export type UpdateAccommodationTaskInput = z.infer<typeof updateAccommodationTaskSchema>;
