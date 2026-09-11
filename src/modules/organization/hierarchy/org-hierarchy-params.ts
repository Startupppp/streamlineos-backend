import { z } from "zod";

export const businessUnitIdParams = z.object({ businessUnitId: z.string().min(1) }).strict();
export const branchIdParams = z.object({ branchId: z.string().min(1) }).strict();
export const departmentIdParams = z.object({ departmentId: z.string().min(1) }).strict();
export const teamIdParams = z.object({ teamId: z.string().min(1) }).strict();
export const locationIdParams = z.object({ locationId: z.string().min(1) }).strict();
export const costCenterIdParams = z.object({ costCenterId: z.string().min(1) }).strict();
