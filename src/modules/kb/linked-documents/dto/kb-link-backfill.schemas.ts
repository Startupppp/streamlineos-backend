import { z } from "zod";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";

export const backfillInputSchema = z
  .object({
    dryRun: z.boolean().default(true),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(PAGE_SIZE_CAP).default(PAGE_SIZE_CAP),
  })
  .strict();
export type BackfillInput = z.infer<typeof backfillInputSchema>;

const count = z.number().int().nonnegative();

export const backfillResultSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: count,
    eligible: count,
    proposals: z.object({ allEmployees: count, hrOnly: count }).strict(),
    skipped: z
      .object({ alreadyClassified: count, belongsToAnEmployee: count, typeNotAllowed: count, hiringArtefact: count, inactive: count, holdsPersonalIdentifier: count })
      .strict(),
    applied: count,
    nextCursor: z.number().int().nullable(),
    done: z.boolean(),
    sample: z.array(z.object({ documentId: z.number().int(), name: z.string(), audience: z.enum(["ALL_EMPLOYEES", "HR_ONLY"]) }).strict()),
  })
  .strict();
export type BackfillResult = z.infer<typeof backfillResultSchema>;
