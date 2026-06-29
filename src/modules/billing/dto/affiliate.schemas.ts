import { z } from "zod";

export const registerAffiliateSchema = z.object({});

export const createReferralSchema = z.object({
  email: z.string().email(),
});
