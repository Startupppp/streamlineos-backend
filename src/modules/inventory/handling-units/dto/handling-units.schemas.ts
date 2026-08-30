import { z } from "zod";

export const handlingUnitKindSchema = z.enum(["PALLET", "CARTON", "CAGE", "TOTE"]);

export const createHandlingUnitSchema = z
  .object({
    /**
     * The label the unit will wear. Omitted means the number sequence mints one
     * - which is the common case, because most units are labelled by us. Supplied
     * means the unit arrived already labelled, typically with a supplier's SSCC.
     */
    huCode: z.string().min(1).max(64).optional(),
    kind: handlingUnitKindSchema.default("PALLET"),
    locationId: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const moveHandlingUnitSchema = z
  .object({
    toLocationId: z.number().int().positive(),
  })
  .strict();

export const nestHandlingUnitSchema = z
  .object({
    /** Null takes the unit out of whatever it was in. */
    parentHuId: z.number().int().positive().nullable(),
  })
  .strict();

export const listHandlingUnitsQuerySchema = z
  .object({
    locationId: z.coerce.number().int().positive().optional(),
    status: z.enum(["OPEN", "CLOSED", "SHIPPED", "EMPTY"]).optional(),
    /** Roots only, for a screen that lists pallets rather than every carton on them. */
    rootsOnly: z.coerce.boolean().optional(),
  })
  .strict();

export type CreateHandlingUnitInput = z.infer<typeof createHandlingUnitSchema>;
export type MoveHandlingUnitInput = z.infer<typeof moveHandlingUnitSchema>;
export type NestHandlingUnitInput = z.infer<typeof nestHandlingUnitSchema>;
export type ListHandlingUnitsQuery = z.infer<typeof listHandlingUnitsQuerySchema>;
