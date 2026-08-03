import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { signAuditEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SignAuditEventType =
  | "envelope_created"
  | "envelope_updated"
  | "envelope_deleted"
  | "document_uploaded"
  | "recipient_added"
  | "recipient_updated"
  | "recipient_removed"
  | "field_added"
  | "field_updated"
  | "field_deleted"
  | "envelope_validated"
  | "envelope_sent"
  | "email_delivered"
  | "email_bounced"
  | "reminder_sent"
  | "signing_link_opened"
  | "authentication_passed"
  | "authentication_failed"
  | "consent_accepted"
  | "document_viewed"
  | "field_completed"
  | "signature_adopted"
  | "recipient_completed"
  | "recipient_declined"
  | "recipient_delegated"
  | "envelope_corrected"
  | "envelope_voided"
  | "envelope_expired"
  | "envelope_extended"
  | "envelope_completed"
  | "final_pdf_generated"
  | "certificate_generated"
  | "certificate_regenerated"
  | "document_downloaded"
  | "template_created"
  | "template_published"
  | "template_archived"
  | "bulk_job_created"
  | "bulk_job_completed"
  | "bulk_job_cancelled"
  | "public_form_published"
  | "public_form_submitted"
  | "admin_setting_changed";

export interface SignAuditActor {
  actorType: "internal_user" | "external_signer" | "system";
  actorUserId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
}

export interface SignAuditRecordInput extends SignAuditActor {
  orgId: string;
  /** Omit for tenant-scoped events (template/bulk-job/admin-setting changes) not tied to one envelope. */
  envelopeId?: number | null;
  recipientId?: number | null;
  eventType: SignAuditEventType;
  eventMessage?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  documentHash?: string | null;
  requestId?: string | null;
  eventPayload?: Record<string, unknown>;
}

/**
 * Append-only writer for the SignOS audit trail. No other code in this module
 * should ever UPDATE or DELETE a sign_audit_events row.
 */
@Injectable()
export class SignAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(input: SignAuditRecordInput, tx?: Tx): Promise<void> {
    const db = (tx ?? this.db) as Db;
    await db.insert(signAuditEvents).values({
      orgId: input.orgId,
      envelopeId: input.envelopeId ?? null,
      recipientId: input.recipientId ?? null,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
      actorEmail: input.actorEmail ?? null,
      eventType: input.eventType,
      eventMessage: input.eventMessage ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      documentHash: input.documentHash ?? null,
      requestId: input.requestId ?? null,
      eventPayloadJson: input.eventPayload ?? null,
    });
  }

  async listForEnvelope(orgId: string, envelopeId: number) {
    return this.db
      .select()
      .from(signAuditEvents)
      .where(and(eq(signAuditEvents.orgId, orgId), eq(signAuditEvents.envelopeId, envelopeId)))
      .orderBy(desc(signAuditEvents.createdAt))
      .limit(100);
  }
}
