import { z } from "zod";

export const createTravelRequestSchema = z.object({
  purpose: z.string().min(1).max(500),
  destination: z.string().min(1).max(255),
  departureDate: z.string().min(1),
  returnDate: z.string().min(1),
  flightRequired: z.boolean().default(false),
  hotelRequired: z.boolean().default(false),
  advanceRequired: z.boolean().default(false),
  advanceAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  estimatedCost: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  perDiem: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  itinerary: z
    .array(
      z.object({
        date: z.string().min(1),
        activity: z.string().min(1),
        location: z.string().min(1),
      }),
    )
    .default([]),
});

export const rejectTravelRequestSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export type CreateTravelRequestInput = z.infer<typeof createTravelRequestSchema>;
export type RejectTravelRequestInput = z.infer<typeof rejectTravelRequestSchema>;
