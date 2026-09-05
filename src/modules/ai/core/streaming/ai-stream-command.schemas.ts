import { z } from "zod";

export const aiStreamCommandRecordSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("started") }).strict(),
  z.object({ state: z.literal("completed"), data: z.unknown() }).strict(),
]);
