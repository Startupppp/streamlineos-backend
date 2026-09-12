import { z } from "zod";

export const dockDirectionSchema = z.enum(["INBOUND", "OUTBOUND"]);

export const createDockDoorSchema = z
  .object({
    warehouseId: z.number().int().positive(),
    /** What is painted on the door. The only identifier a driver is given. */
    code: z.string().min(1).max(40),
    name: z.string().max(120).optional(),
    /** Absent means either way, which is the common case for a two-door site. */
    direction: dockDirectionSchema.optional(),
  })
  .strict();

export const bookAppointmentSchema = z
  .object({
    doorId: z.number().int().positive(),
    direction: dockDirectionSchema,
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    carrierName: z.string().max(200).optional(),
    vehicleRef: z.string().max(64).optional(),
    reference: z.string().max(120).optional(),
    asnId: z.number().int().positive().optional(),
    loadId: z.number().int().positive().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => new Date(v.windowEnd) > new Date(v.windowStart), {
    message: "An appointment must end after it starts",
    path: ["windowEnd"],
  })
  .refine((v) => v.asnId === undefined || v.loadId === undefined, {
    message: "An appointment is for a shipment or for a load, not both",
    path: ["loadId"],
  });

export const listAppointmentsQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .strict()
  .refine((v) => new Date(v.to) > new Date(v.from), {
    message: "The window must end after it starts",
    path: ["to"],
  });

export const setAppointmentStatusSchema = z
  .object({ status: z.enum(["ARRIVED", "COMPLETED", "CANCELLED", "NO_SHOW"]) })
  .strict();

export type CreateDockDoorInput = z.infer<typeof createDockDoorSchema>;
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
export type SetAppointmentStatusInput = z.infer<typeof setAppointmentStatusSchema>;
