import { z } from "zod";

export const auditLogResponseSchema = z.object({ ok: z.literal(true) });
