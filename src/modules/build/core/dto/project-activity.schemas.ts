import { z } from "zod";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { wireDate } from "../../../../common/openapi/wire-types";

const projectActivityItemSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  label: z.string(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  createdAt: wireDate(),
  ticketId: z.number().int(),
  ticketTitle: z.string(),
  ticketNumber: z.number().int(),
  projectKey: z.string(),
  user: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const projectActivityPageSchema = cursorPageSchema(projectActivityItemSchema);
