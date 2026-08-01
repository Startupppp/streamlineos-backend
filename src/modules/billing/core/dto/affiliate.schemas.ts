import { z } from "zod";

export const createReferralSchema = z.object({
  email: z.string().email(),
});
