import { z } from "zod";

export function validateAgainstSchema<T>(
  value: unknown,
  schema: z.ZodType<T>,
): { valid: boolean; errors: string[] } {
  const result = schema.safeParse(value);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
  );
  return { valid: false, errors };
}
