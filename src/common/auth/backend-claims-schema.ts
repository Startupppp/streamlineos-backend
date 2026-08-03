import { z } from "zod";

export const backendJwtPayloadSchema = z.object({
  sub: z.string().min(1),
  sessionId: z.string().min(1),
  orgId: z.string().min(1).nullish(),
});

export type BackendJwtPayload = z.infer<typeof backendJwtPayloadSchema>;
