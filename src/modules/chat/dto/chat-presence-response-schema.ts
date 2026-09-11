import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

export const chatPresenceAckResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const chatUnreadResponseSchema = z.object({
  total: z.number().int().min(0).max(100),
}).strict();

export const chatOnlineResponseSchema = z.array(z.object({
  userId: z.string(),
  status: z.string(),
  lastSeenAt: wireDate(),
  userName: z.string().nullable(),
  userImage: z.string().nullable(),
}).strict()).max(500);

export const chatUsersResponseSchema = z.array(z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  role: z.string(),
}).strict()).max(500);
