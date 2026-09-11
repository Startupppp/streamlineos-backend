import { BadRequestException, ForbiddenException, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signEnvelopes, signFields, signRecipients, signSignatureAssets } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import { SignAuditService } from "../sign-audit.service";
import { SignTokensService } from "../sign-tokens.service";
import type { AdoptSignatureInput, PublicFieldValueInput } from "../dto/e-sign.schemas";
import { withRecipientSession, type PublicRequestContext } from "./recipient-session";

/**
 * What the recipient puts INTO the document.
 *
 * Both of these write a field value and both refuse until consent has been
 * accepted, which is the line they share with nothing else on the public
 * surface: identity is proved before this, the envelope is settled after it.
 *
 * They are split from each other only by field type, and deliberately not
 * merged: `setFieldValue` refuses a signature-shaped field outright and points
 * at `adoptSignature`, because adopting is not a value edit — it uploads an
 * image, creates a reusable asset row, and stamps every matching field at once.
 * A single endpoint would have to decide which of those two things a caller
 * meant from the payload.
 */
export interface RecipientInputDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly tokens: SignTokensService;
  readonly audit: SignAuditService;
  readonly storage: StorageService;
  /** The session-state gate, bound from the service. See `RecipientIdentityDeps`. */
  readonly assertActive: (
    recipient: typeof signRecipients.$inferSelect,
    envelope: typeof signEnvelopes.$inferSelect,
  ) => void;
}

export async function setFieldValue(
  deps: RecipientInputDeps,
  token: string,
  fieldId: number,
  input: PublicFieldValueInput,
) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    const field = await deps.db.query.signFields.findFirst({ where: and(eq(signFields.id, fieldId), eq(signFields.recipientId, recipient.id)) });
    if (!field) throw new NotFoundException("Field not found");
    if (field.readonly) throw new ForbiddenException("This field is read-only");
    if (field.fieldType === "signature" || field.fieldType === "initials" || field.fieldType === "stamp") {
      throw new BadRequestException("Use the adopt-signature endpoint for this field type");
    }
    if (field.fieldType === "dropdown" || field.fieldType === "radio") {
      if (typeof input.value === "string" && field.optionsJson && !field.optionsJson.includes(input.value)) {
        throw new BadRequestException("Selected value is not one of the allowed options");
      }
    }

    const valueJson = field.fieldType === "checkbox" ? { checked: Boolean(input.value) } : { value: input.value };
    await deps.db
      .update(signFields)
      .set({ valueJson, completedAt: input.value ? new Date() : null })
      .where(eq(signFields.id, fieldId));

    return { success: true };
  });
}

export async function adoptSignature(
  deps: RecipientInputDeps,
  token: string,
  input: AdoptSignatureInput,
  ctx: PublicRequestContext,
) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    let imageFileKey: string | undefined;
    if (input.imageDataUrl) {
      const base64 = input.imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64, "base64");
      const uploaded = await deps.storage.uploadFile(envelope.orgId, buffer, `signos/${envelope.orgId}/${envelope.id}/signatures`, `${input.assetType}.png`, "image/png");
      imageFileKey = uploaded.key;
    }

    const [asset] = await deps.db
      .insert(signSignatureAssets)
      .values({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        assetType: input.assetType,
        method: input.method,
        imageFileKey,
        typedText: input.typedText,
        typedFontStyle: input.typedFontStyle,
      })
      .returning();

    const matchingFields = await deps.db.query.signFields.findMany({
      where: and(eq(signFields.recipientId, recipient.id), eq(signFields.fieldType, input.assetType)),
    });
    for (const field of matchingFields) {
      if (field.completedAt) continue;
      await deps.db
        .update(signFields)
        .set({ valueJson: { signatureAssetId: asset.id }, completedAt: new Date() })
        .where(eq(signFields.id, field.id));
    }

    await deps.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "signature_adopted",
      eventMessage: `Adopted ${input.assetType} via ${input.method}`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return asset;
  });
}
