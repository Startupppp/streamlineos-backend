import { z } from "zod";

export const vapidPublicKeyResponseSchema = z.object({ key: z.string() });

export const pushSubscribeResponseSchema = z.object({ success: z.literal(true) });

export const pushUnsubscribeResponseSchema = z.object({ success: z.literal(true) });
