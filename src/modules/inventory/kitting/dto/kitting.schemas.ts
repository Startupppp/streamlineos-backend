import { z } from "zod";

const qtyString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Quantity must be a positive decimal with up to 4 places")
  .refine((v) => Number(v) > 0, "Quantity must be greater than zero");

export const setKitBomSchema = z
  .object({
    /**
     * The whole bill of materials. Wholesale rather than line by line: "these
     * are the components" is what somebody editing a kit means, and a partial
     * merge would need a stable line identity they do not have in front of them.
     * An empty list clears it, which is how a kit stops being a kit.
     */
    components: z
      .array(
        z
          .object({
            componentVariantId: z.number().int().positive(),
            quantityPer: qtyString,
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    for (const [index, line] of value.components.entries()) {
      if (seen.has(line.componentVariantId)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "componentVariantId"],
          message:
            "This component appears twice. Add its quantities together into one line rather than making every reader do it.",
        });
      }
      seen.add(line.componentVariantId);
    }
  });

export const assembleKitSchema = z
  .object({
    kitVariantId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    quantity: qtyString,
  })
  .strict();

export const disassembleKitSchema = assembleKitSchema;

export const buildableQuerySchema = z
  .object({
    kitVariantId: z.coerce.number().int().positive(),
    warehouseId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type SetKitBomInput = z.infer<typeof setKitBomSchema>;
export type AssembleKitInput = z.infer<typeof assembleKitSchema>;
export type DisassembleKitInput = z.infer<typeof disassembleKitSchema>;
export type BuildableQuery = z.infer<typeof buildableQuerySchema>;
