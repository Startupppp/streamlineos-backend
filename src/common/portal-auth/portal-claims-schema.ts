import { z } from "zod";
import { PORTAL_AUDIENCE } from "./portal-claims";

const audSchema = z.preprocess(
  (v) => (Array.isArray(v) ? v[0] : v),
  z
    .string()
    .refine((v) => v === PORTAL_AUDIENCE, { message: "invalid audience" }),
);

export const portalJwtPayloadSchema = z.object({
  aud: audSchema,
  sub: z.string().min(1, "sub (portalMembershipId) is required"),
  orgId: z.string().min(1, "orgId is required"),
  sessionEpoch: z.number().int().nonnegative(),
});

export type PortalJwtPayload = z.infer<typeof portalJwtPayloadSchema>;
