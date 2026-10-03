import { z } from "zod";

export const sampleDataStatusSchema = z
  .object({
    present: z.boolean(),
    people: z.number().int(),
    payees: z.number().int(),
    salaryProfiles: z.number().int(),
  })
  .strict();

export type SampleDataStatus = z.infer<typeof sampleDataStatusSchema>;
