import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const integrationToolkit = z.enum(["googlecalendar", "outlook", "gmail"]);
const integrationConnectionStatus = z.enum(["active", "needs_reauth", "disabled"]);

const connectionRowSchema = z.object({
  id: z.number().int().positive(),
  status: integrationConnectionStatus,
  toolkit: integrationToolkit,
  isPrimary: z.boolean(),
  createdAt: wireDate(),
  accountEmail: z.string().nullable(),
  accountLabel: z.string().nullable(),
});

export const integrationsListResponseSchema = z.array(connectionRowSchema);

export const integrationsInitiateResponseSchema = z.object({ redirectUrl: z.string() });

export const integrationsFinalizeResponseSchema = connectionRowSchema;

export const integrationsDisconnectResponseSchema = z.object({ deleted: z.literal(true) });

export const integrationsSetPrimaryResponseSchema = connectionRowSchema;
