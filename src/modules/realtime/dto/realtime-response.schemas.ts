import { z } from "zod";

const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const iceServersResponseSchema = z.object({
  iceServers: z.array(iceServerSchema),
});
