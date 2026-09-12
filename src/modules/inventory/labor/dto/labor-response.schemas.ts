import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

/**
 * NEO-7 — `LaborBoardRow` (`LaborPerformance` plus the person's name).
 *
 * The board's figures are aggregated in SQL and coerced to numbers in
 * `performanceOf`, so unlike the record rows below they are genuine JSON
 * numbers rather than decimal strings. `performancePct` reads the way a
 * warehouse already means it: above 100 is faster than standard.
 */
export const laborBoardResponseSchema = z.array(
  z.object({
    userId: z.string(),
    userName: z.string().nullable(),
    lines: z.number().int(),
    unitsDone: z.number(),
    actualSeconds: z.number().int(),
    standardSeconds: z.number().int(),
    performancePct: z.number(),
    unitsPerHour: z.number().nullable(),
  }),
);

/**
 * One person's recent lines — the drill-down behind a board figure. These come
 * straight off `inv_labor_records`, so `unitsDone` is the `decimal` column's
 * exact string rather than the board's aggregated number.
 */
export const laborRecordsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    taskKind: z.string(),
    taskId: z.number().int(),
    locationId: z.number().int().nullable(),
    startedAt: wireDate(),
    completedAt: wireDate(),
    unitsDone: z.string(),
    scanCount: z.number().int(),
    distanceProxy: z.number().int(),
    standardSeconds: z.number().int(),
  }),
);
