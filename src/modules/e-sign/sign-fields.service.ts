import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes, signFields, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { isEnvelopeEditable } from "./sign-state";
import type { CreateFieldInput, UpdateFieldInput } from "./dto/e-sign.schemas";
import type { SignActorContext } from "./sign-recipients.service";

@Injectable()
export class SignFieldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
  ) {}

  private async loadEditableEnvelope(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Fields can only be edited on a draft envelope");
    }
    return envelope;
  }

  private validateFieldRules(input: CreateFieldInput | UpdateFieldInput): void {
    if (input.fieldType === "dropdown" && (!input.optionsJson || input.optionsJson.length === 0)) {
      throw new BadRequestException("Dropdown fields require at least one option");
    }
    if (input.fieldType === "radio" && (!input.optionsJson || input.optionsJson.length < 2)) {
      throw new BadRequestException("Radio group fields require at least two options");
    }
    if (input.fieldType === "radio" && !("groupId" in input && input.groupId)) {
      throw new BadRequestException("Radio group fields require a group identity");
    }
    if (input.width !== undefined && input.width <= 0) throw new BadRequestException("Field width must be positive");
    if (input.height !== undefined && input.height <= 0) throw new BadRequestException("Field height must be positive");
  }

  async add(orgId: string, envelopeId: number, input: CreateFieldInput, actor: SignActorContext) {
    await this.loadEditableEnvelope(orgId, envelopeId);
    this.validateFieldRules(input);

    const document = await this.db.query.signDocuments.findFirst({
      where: and(eq(signDocuments.id, input.documentId), eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
    });
    if (!document) throw new BadRequestException("Document does not belong to this envelope");
    if (document.pageCount && input.pageNumber > document.pageCount) {
      throw new BadRequestException(`Document only has ${document.pageCount} pages`);
    }

    const recipient = await this.db.query.signRecipients.findFirst({
      where: and(eq(signRecipients.id, input.recipientId), eq(signRecipients.orgId, orgId), eq(signRecipients.envelopeId, envelopeId)),
    });
    if (!recipient) throw new BadRequestException("Recipient does not belong to this envelope");

    const isDateSigned = input.fieldType === "date_signed";

    const [field] = await this.db
      .insert(signFields)
      .values({
        orgId,
        envelopeId,
        documentId: input.documentId,
        recipientId: input.recipientId,
        fieldType: input.fieldType,
        label: input.label,
        pageNumber: input.pageNumber,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        required: isDateSigned ? true : input.required,
        readonly: isDateSigned ? true : input.readonly,
        orderIndex: input.orderIndex,
        groupId: input.groupId,
        defaultValue: input.defaultValue,
        optionsJson: input.optionsJson,
        validationType: input.validationType,
        validationRulesJson: input.validationRulesJson,
        conditionalRulesJson: input.conditionalRulesJson,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      recipientId: input.recipientId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "field_added",
      eventMessage: `Added ${input.fieldType} field on page ${input.pageNumber}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return field;
  }

  async update(orgId: string, fieldId: number, input: UpdateFieldInput, actor: SignActorContext) {
    const field = await this.get(orgId, fieldId);
    await this.loadEditableEnvelope(orgId, field.envelopeId);
    if (Object.keys(input).length > 0) this.validateFieldRules({ ...field, ...input } as CreateFieldInput);

    const [updated] = await this.db
      .update(signFields)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(signFields.id, fieldId), eq(signFields.orgId, orgId)))
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: field.envelopeId,
      recipientId: field.recipientId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "field_updated",
      eventMessage: `Updated field ${field.id}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }

  async remove(orgId: string, fieldId: number, actor: SignActorContext) {
    const field = await this.get(orgId, fieldId);
    await this.loadEditableEnvelope(orgId, field.envelopeId);

    await this.db.delete(signFields).where(eq(signFields.id, fieldId));

    await this.audit.record({
      orgId,
      envelopeId: field.envelopeId,
      recipientId: field.recipientId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "field_deleted",
      eventMessage: `Deleted field ${fieldId}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  async get(orgId: string, fieldId: number) {
    const field = await this.db.query.signFields.findFirst({
      where: and(eq(signFields.id, fieldId), eq(signFields.orgId, orgId)),
    });
    if (!field) throw new NotFoundException("Field not found");
    return field;
  }

  async listForEnvelope(orgId: string, envelopeId: number) {
    return this.db.query.signFields.findMany({
      where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)),
      orderBy: (f, { asc }) => [asc(f.pageNumber), asc(f.orderIndex)],
      limit: 100,
    });
  }
}
