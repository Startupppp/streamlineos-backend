import { z } from "zod";

/** INV-306. A bounded set of what-ifs; a simulator that runs any number of them is a way to make the database do arbitrary work. */
export const simulateSchema = z
  .object({
    serviceLevel: z.number().gt(0).lt(1).optional(),
    scenarios: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            demandMultiplier: z.number().gt(0).lte(100).optional(),
            leadTimeWeeks: z.number().gte(0).lte(520).optional(),
            leadTimeStdDevWeeks: z.number().gte(0).lte(520).optional(),
            serviceLevel: z.number().gt(0).lt(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type SimulateInput = z.infer<typeof simulateSchema>;
