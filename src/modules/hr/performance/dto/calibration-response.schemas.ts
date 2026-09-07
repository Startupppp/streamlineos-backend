import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const calibrationEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  cycleId: z.number().int(),
  employeeId: z.string(),
  employeeMembershipId: z.number().int().nullable(),
  preRating: z.string().nullable(),
  postRating: z.string().nullable(),
  calibratedBy: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCalibrationEntriesResponseSchema = z.array(calibrationEntrySchema);

export const upsertCalibrationEntryResponseSchema = calibrationEntrySchema;

export const getNineBoxResponseSchema = z.array(
  z.object({
    employeeId: z.string(),
    performance: z.number(),
    potential: z.number(),
    box: z.string(),
    note: z.string().nullable(),
  }),
);
