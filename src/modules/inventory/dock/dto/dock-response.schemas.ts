import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

/**
 * NEO-12 — the dock calendar's wire shapes.
 *
 * `direction` is nullable on a door and not on an appointment, and the
 * difference is the product's: a small site's door takes goods either way,
 * while a booking is always one or the other.
 */
const dockDoorSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  warehouseId: z.number().int(),
  code: z.string(),
  name: z.string().nullable(),
  direction: z.string().nullable(),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listDockDoorsResponseSchema = z.array(dockDoorSchema);
export const createDockDoorResponseSchema = dockDoorSchema;

/** The whole appointment row, as `book` and `setStatus` return it. */
const dockAppointmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  warehouseId: z.number().int(),
  doorId: z.number().int(),
  direction: z.string(),
  status: z.string(),
  windowStart: wireDate(),
  windowEnd: wireDate(),
  carrierName: z.string().nullable(),
  vehicleRef: z.string().nullable(),
  reference: z.string().nullable(),
  asnId: z.number().int().nullable(),
  loadId: z.number().int().nullable(),
  arrivedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const bookDockAppointmentResponseSchema = dockAppointmentSchema;
export const setDockAppointmentStatusResponseSchema = dockAppointmentSchema;

/**
 * The calendar's own projection, which carries the door's painted code rather
 * than only its id — that code is the only identifier a driver is given.
 */
export const listDockAppointmentsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    warehouseId: z.number().int(),
    doorId: z.number().int(),
    doorCode: z.string(),
    direction: z.string(),
    status: z.string(),
    windowStart: wireDate(),
    windowEnd: wireDate(),
    carrierName: z.string().nullable(),
    vehicleRef: z.string().nullable(),
    reference: z.string().nullable(),
    asnId: z.number().int().nullable(),
    loadId: z.number().int().nullable(),
  }),
);
