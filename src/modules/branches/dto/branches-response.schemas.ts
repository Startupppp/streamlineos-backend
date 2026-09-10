import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const branchStaffSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

export const branchListItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  code: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  pincode: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  branchManager: branchStaffSchema.nullable(),
  branchHr: branchStaffSchema.nullable(),
});

export const branchDetailSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  code: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  pincode: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  branchManager: branchStaffSchema.nullable(),
  branchHr: branchStaffSchema.extend({ email: z.string().nullable() }).nullable(),
  employees: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      image: z.string().nullable(),
      role: z.string(),
      isActive: z.boolean(),
    }),
  ),
});

export const branchListSchema = z.array(branchListItemSchema);
