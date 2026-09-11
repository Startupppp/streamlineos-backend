import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { signAuditEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SIGN_GEO_IP, type SignGeoIpPort } from "./geo/geo-ip.port";
import { mustGetVisibleEnvelope } from "./sign-envelope-scope";
import type { ScopedRead } from "../access/scoped-read";

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

type SignAuditRow = typeof signAuditEvents.$inferInsert;

function toRow(input: SignAuditRecordInput): SignAuditRow {
  return {
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
  };
}

/**
 * Rows per multi-row INSERT. Fourteen bound parameters per row keeps a full
 * chunk at 7,000 placeholders, an order of magnitude under the 65,535 a single
 * Postgres statement can bind, and one chunk is the unit that commits together.
 */
export const SIGN_AUDIT_INSERT_CHUNK = 500;

/**
 * Append-only writer for the SignOS audit trail. No other code in this module
 * should ever UPDATE or DELETE a sign_audit_events row.
 */
@Injectable()
export class SignAuditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(SIGN_GEO_IP) private readonly geo: SignGeoIpPort,
  ) {}

  /**
   * Records one event or a batch of them.
   *
   * A batch is one multi-row INSERT per {@link SIGN_AUDIT_INSERT_CHUNK}, not one
   * INSERT per event: a sweep that flips N envelopes owes N audit rows, and
   * issuing those one at a time is the per-row write shape §5.1 bans. The batch
   * arrives through this same entry point rather than a second method so the
   * append-only rule above still has exactly one door to guard.
   */
  async record(input: SignAuditRecordInput | readonly SignAuditRecordInput[], tx?: Tx): Promise<void> {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) return;
    const db = tx ?? this.db;
    const rows = await Promise.all(
      inputs.map(async (one) => ({ ...toRow(one), geolocationJson: await this.locate(one.ipAddress) })),
    );
    for (let offset = 0; offset < rows.length; offset += SIGN_AUDIT_INSERT_CHUNK) {
      await db.insert(signAuditEvents).values(rows.slice(offset, offset + SIGN_AUDIT_INSERT_CHUNK));
    }
  }

  /**
   * SIGN-P0-08. `geolocation_json` has existed since SignOS shipped and
   * nothing has ever written to it.
   *
   * Best effort, and the catch is the important half: this runs on the path
   * that records a signature, and a geo lookup failing must never be the
   * reason a signature goes unrecorded. `AddressGeoIp` already promises not
   * to throw; the guard here is because the binding can be replaced with
   * something that talks to a network, and that implementation will not have
   * been written by anyone thinking about this line.
   */
  private async locate(ipAddress: string | null | undefined): Promise<Record<string, unknown> | null> {
    try {
      return ((await this.geo.locate(ipAddress)) as Record<string, unknown> | null) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * `sign:audit:view` is not scopable, so its own grant can only say "all". The
   * trail names who opened, signed and downloaded what and when, so it is bound
   * to the caller's `sign:envelope:view` scope for the same reason the final PDF
   * is: an envelope you may not see has no readable history.
   */
  async listForEnvelope(read: ScopedRead, membershipId: number | null, envelopeId: number) {
    await mustGetVisibleEnvelope(this.db, read, membershipId, envelopeId, "Envelope not found");
    return this.db
      .select()
      .from(signAuditEvents)
      .where(and(eq(signAuditEvents.orgId, read.orgId), eq(signAuditEvents.envelopeId, envelopeId)))
      .orderBy(desc(signAuditEvents.createdAt))
      .limit(100);
  }
}
