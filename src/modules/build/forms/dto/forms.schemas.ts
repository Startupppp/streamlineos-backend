import { z } from "zod";
import { formTypeEnum, formSubmissionStatusEnum } from "../../../../db/schema";

const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const actionSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const listFormsQuerySchema = z.object({
  type: z.enum(formTypeEnum.enumValues).optional(),
  isActive: z
    .preprocess(
      (v) => (v === "true" ? true : v === "false" ? false : undefined),
      z.boolean().optional(),
    )
    .optional(),
}).strict();

export const createFormSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  type: z.enum(formTypeEnum.enumValues).optional(),
  fields: z.array(fieldSchema),
  actions: z.array(actionSchema),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
}).strict();

export const updateFormSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  type: z.enum(formTypeEnum.enumValues).optional(),
  fields: z.array(fieldSchema).optional(),
  actions: z.array(actionSchema).optional(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
}).strict();

export const createSubmissionSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  submittedByName: z.string().optional(),
}).strict();

export const updateSubmissionSchema = z.object({
  status: z.enum(formSubmissionStatusEnum.enumValues),
}).strict();

export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>;
export type CreateFormInput = z.infer<typeof createFormSchema>;
export type UpdateFormInput = z.infer<typeof updateFormSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
export type UpdateSubmissionInput = z.infer<typeof updateSubmissionSchema>;
