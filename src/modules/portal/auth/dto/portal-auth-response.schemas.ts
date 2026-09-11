import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const mintedTokenSchema = z.object({
  token: z.string(),
  expiresAt: wireDate(),
});
