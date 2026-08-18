import { z } from "zod";

export const directDatabaseUrlSchema = z.string().url().superRefine(
  (value, context) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DIRECT_DATABASE_URL must use a PostgreSQL protocol",
      });
    if (!parsed.hostname || !parsed.username)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DIRECT_DATABASE_URL must identify a host and user",
      });
  },
);
