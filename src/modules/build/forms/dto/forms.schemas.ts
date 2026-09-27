import { z } from "zod";
import { formTypeEnum, formSubmissionStatusEnum } from "../../../../db/schema";

const conditionOperatorEnum = z.enum([
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "lt",
  "is_empty",
  "is_not_empty",
]);

const conditionSchema = z
  .object({
    fieldKey: z.string().min(1),
    operator: conditionOperatorEnum,
    value: z.unknown().optional(),
  })
  .strict();

const conditionalLogicSchema = z
  .object({
    action: z.enum(["show", "hide"]),
    match: z.enum(["all", "any"]),
    conditions: z.array(conditionSchema).min(1).max(20),
  })
  .strict();

const fieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
    conditionalLogic: conditionalLogicSchema.optional(),
  })
  .strict();

const actionSchema = z
  .object({
    type: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type FormField = z.infer<typeof fieldSchema>;

const NUMERIC_CONDITION_OPERATORS: ReadonlySet<string> = new Set(["gt", "lt"]);
const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set([
  "number",
  "rating",
  "scale",
]);

const fieldsSchema = z
  .array(fieldSchema)
  .superRefine((fields: FormField[], ctx) => {
    const fieldMap = new Map<string, FormField>(
      fields.map((field) => [field.key, field]),
    );
    const dependencies = new Map<string, string[]>();

    for (const field of fields) {
      if (!field.conditionalLogic) continue;
      const referencedKeys: string[] = [];
      for (const condition of field.conditionalLogic.conditions) {
        const referenced = fieldMap.get(condition.fieldKey);
        if (!referenced) {
          ctx.addIssue({
            code: "custom",
            message: `Condition references unknown field key "${condition.fieldKey}"`,
          });
          return;
        }
        if (condition.fieldKey === field.key) {
          ctx.addIssue({
            code: "custom",
            message: `Field "${field.key}" cannot reference itself in conditional logic`,
          });
          return;
        }
        if (
          NUMERIC_CONDITION_OPERATORS.has(condition.operator) &&
          !NUMERIC_FIELD_TYPES.has(referenced.type)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `Operator "${condition.operator}" requires a numeric field but "${condition.fieldKey}" is type "${referenced.type}"`,
          });
          return;
        }
        referencedKeys.push(condition.fieldKey);
      }
      dependencies.set(field.key, referencedKeys);
    }

    const settled = new Set<string>();
    const inProgress = new Set<string>();

    const reachesCycle = (key: string): boolean => {
      if (inProgress.has(key)) return true;
      if (settled.has(key)) return false;
      settled.add(key);
      inProgress.add(key);
      for (const dependency of dependencies.get(key) ?? []) {
        if (reachesCycle(dependency)) return true;
      }
      inProgress.delete(key);
      return false;
    };

    for (const key of fieldMap.keys()) {
      if (reachesCycle(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Conditional logic contains a cycle",
        });
        return;
      }
    }
  });

export const listFormsQuerySchema = z
  .object({
    type: z.enum(formTypeEnum.enumValues).optional(),
    isActive: z
      .preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : undefined),
        z.boolean().optional(),
      )
      .optional(),
    cursor: z.string().min(1).optional(),
    q: z.string().max(200).optional(),
  })
  .strict();

export const createFormSchema = z
  .object({
    name: z.string().min(1).max(500),
    description: z.string().optional(),
    type: z.enum(formTypeEnum.enumValues).optional(),
    fields: fieldsSchema,
    actions: z.array(actionSchema),
    isActive: z.boolean().optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();

export const updateFormSchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    description: z.string().nullish(),
    type: z.enum(formTypeEnum.enumValues).optional(),
    fields: fieldsSchema.optional(),
    actions: z.array(actionSchema).optional(),
    isActive: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    version: z.string().datetime().optional(),
  })
  .strict();

export const listSubmissionsQuerySchema = z
  .object({
    status: z.enum(formSubmissionStatusEnum.enumValues).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const createSubmissionSchema = z
  .object({
    values: z.record(z.string(), z.unknown()),
    submittedByName: z.string().optional(),
  })
  .strict();

export const updateSubmissionSchema = z
  .object({
    status: z.enum(formSubmissionStatusEnum.enumValues),
  })
  .strict();

export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>;
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;
export type CreateFormInput = z.infer<typeof createFormSchema>;
export type UpdateFormInput = z.infer<typeof updateFormSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
export type UpdateSubmissionInput = z.infer<typeof updateSubmissionSchema>;
