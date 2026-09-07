import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const calibrationEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  cycleId: z.number().int().nullable(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  performanceScore: z.string().nullable(),
  potentialScore: z.string().nullable(),
  box: z.string().nullable(),
  note: z.string().nullable(),
  calibratedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCalibrationEntriesResponseSchema = z.array(calibrationEntrySchema);

export const upsertCalibrationEntryResponseSchema = calibrationEntrySchema;

export const getNineBoxResponseSchema = z.array(
  z.object({
    employeeId: z.string(),
    performance: z.string().nullable(),
    potential: z.string().nullable(),
    box: z.string().nullable(),
    note: z.string().nullable(),
  }),
);
