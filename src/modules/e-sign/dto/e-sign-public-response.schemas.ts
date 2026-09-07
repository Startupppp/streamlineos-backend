import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { signFieldRowSchema } from "./e-sign-fields-response.schemas";
import { signTemplateRowSchema } from "./e-sign-templates-response.schemas";

export const getSessionResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("active"),
    envelope: z.object({
      id: z.number().int(),
      title: z.string(),
      subject: z.string().nullable(),
      message: z.string().nullable(),
      expiresAt: nullableWireDate(),
    }),
    sender: z.object({ name: z.string() }),
    recipient: z.object({
      id: z.number().int(),
      name: z.string(),
      email: z.string().nullable(),
      authMethod: z.string(),
      authenticated: z.boolean(),
      consentAccepted: z.boolean(),
    }),
    documents: z.array(
      z.object({ id: z.number().int(), fileName: z.string(), pageCount: z.number().int().nullable() }),
    ),
    fields: z.array(signFieldRowSchema),
  }),
  z.object({
    state: z.string().refine((s) => s !== "active"),
    envelopeTitle: z.string(),
    recipientName: z.string(),
  }),
]);

export const requestOtpResponseSchema = z.object({ sent: z.literal(true) });

export const authenticateResponseSchema = z.object({ authenticated: z.literal(true) });

export const consentResponseSchema = z.object({ accepted: z.literal(true) });

export const setFieldValueResponseSchema = z.object({ success: z.literal(true) });

const signatureAssetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  recipientId: z.number().int(),
  assetType: z.enum(["signature", "initials", "stamp"]),
  method: z.enum(["drawn", "typed", "uploaded", "saved"]),
  imageFileKey: z.string().nullable(),
  typedText: z.string().nullable(),
  typedFontStyle: z.string().nullable(),
  createdAt: wireDate(),
});

export const adoptSignatureResponseSchema = signatureAssetRowSchema;

export const completeSigningResponseSchema = z.object({
  completed: z.literal(true),
  envelopeCompleted: z.boolean(),
});

export const declineSigningResponseSchema = z.object({ declined: z.literal(true) });

export const getPublicFormResponseSchema = z.object({
  form: z.object({
    slug: z.string(),
    requiresAccessCode: z.boolean(),
    embedAllowed: z.boolean(),
  }),
  template: signTemplateRowSchema,
});

export const submitPublicFormResponseSchema = z.object({
  token: z.string(),
  recipientId: z.number().int(),
  envelopeId: z.number().int(),
  redirectUrl: z.string().nullable(),
});
