import { pgEnum } from "drizzle-orm/pg-core";

export const signEnvelopeStatusEnum = pgEnum("sign_envelope_status", [
  "draft",
  "ready_to_send",
  "sent",
  "delivered",
  "partially_completed",
  "completed",
  "declined",
  "voided",
  "expired",
  "correction_required",
  "failed",
]);

export const signRoutingModeEnum = pgEnum("sign_routing_mode", ["parallel", "sequential", "mixed"]);

export const signCcTimingEnum = pgEnum("sign_cc_timing", ["on_send", "on_complete"]);

export const signRecipientStatusEnum = pgEnum("sign_recipient_status", [
  "pending",
  "invited",
  "viewed",
  "authenticated",
  "signing",
  "completed",
  "declined",
  "delegated",
  "bounced",
  "expired",
]);

export const signRecipientTypeEnum = pgEnum("sign_recipient_type", [
  "signer",
  "approver",
  "cc",
  "viewer",
  "in_person_host",
  "internal_reviewer",
]);

export const signAuthMethodEnum = pgEnum("sign_auth_method", [
  "email_link",
  "access_code",
  "otp_email",
  "otp_sms",
  "sso",
  "passkey",
  "kba",
  "id_verification",
]);

export const signConversionStatusEnum = pgEnum("sign_conversion_status", [
  "pending",
  "converted",
  "failed",
  "not_needed",
]);

export const signFieldTypeEnum = pgEnum("sign_field_type", [
  "signature",
  "initials",
  "date_signed",
  "text",
  "multiline",
  "email",
  "name",
  "company",
  "title",
  "checkbox",
  "radio",
  "dropdown",
  "attachment",
  "stamp",
  "strikethrough",
  "readonly_merge",
]);

export const signTemplateStatusEnum = pgEnum("sign_template_status", ["draft", "published", "archived"]);

export const signSignatureAssetTypeEnum = pgEnum("sign_signature_asset_type", ["signature", "initials", "stamp"]);

export const signSignatureMethodEnum = pgEnum("sign_signature_method", ["drawn", "typed", "uploaded", "saved"]);

export const signActorTypeEnum = pgEnum("sign_actor_type", ["internal_user", "external_signer", "system"]);

export const signAuditEventTypeEnum = pgEnum("sign_audit_event_type", [
  "envelope_created",
  "envelope_updated",
  "envelope_deleted",
  "document_uploaded",
  "recipient_added",
  "recipient_updated",
  "recipient_removed",
  "field_added",
  "field_updated",
  "field_deleted",
  "envelope_validated",
  "envelope_sent",
  "email_delivered",
  "email_bounced",
  "reminder_sent",
  "signing_link_opened",
  "authentication_passed",
  "authentication_failed",
  "consent_accepted",
  "document_viewed",
  "field_completed",
  "signature_adopted",
  "recipient_completed",
  "recipient_declined",
  "recipient_delegated",
  "envelope_corrected",
  "envelope_voided",
  "envelope_expired",
  "envelope_extended",
  "envelope_completed",
  "final_pdf_generated",
  "certificate_generated",
  "certificate_regenerated",
  "document_downloaded",
  "template_created",
  "template_published",
  "template_archived",
  "bulk_job_created",
  "bulk_job_completed",
  "bulk_job_cancelled",
  "public_form_published",
  "public_form_submitted",
  "admin_setting_changed",
]);

export const signBulkJobStatusEnum = pgEnum("sign_bulk_job_status", [
  "pending",
  "validating",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const signBulkRowStatusEnum = pgEnum("sign_bulk_row_status", ["pending", "success", "failed"]);

export const signWatermarkScopeEnum = pgEnum("sign_watermark_scope", ["tenant", "template", "envelope"]);

export const signPublicFormStatusEnum = pgEnum("sign_public_form_status", ["draft", "published", "unpublished"]);
