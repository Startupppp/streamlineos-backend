-- 0967_ar02_canonical_tenant_fks_5 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags DROP CONSTRAINT IF EXISTS "fk_support_ticket_tags_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags
  ADD CONSTRAINT "fk_support_ticket_tags_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags DROP CONSTRAINT IF EXISTS "fk_support_ticket_tags_tag_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags
  ADD CONSTRAINT "fk_support_ticket_tags_tag_id_org"
  FOREIGN KEY (org_id, tag_id)
  REFERENCES public.support_tags (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_messages DROP CONSTRAINT IF EXISTS "fk_support_ticket_messages_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_messages
  ADD CONSTRAINT "fk_support_ticket_messages_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_links DROP CONSTRAINT IF EXISTS "fk_support_ticket_links_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_links
  ADD CONSTRAINT "fk_support_ticket_links_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_links DROP CONSTRAINT IF EXISTS "fk_support_ticket_links_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_external_links DROP CONSTRAINT IF EXISTS "fk_support_ticket_external_links_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_external_links
  ADD CONSTRAINT "fk_support_ticket_external_links_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_embeddings DROP CONSTRAINT IF EXISTS "fk_support_ticket_embeddings_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_embeddings
  ADD CONSTRAINT "fk_support_ticket_embeddings_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_drafts DROP CONSTRAINT IF EXISTS "fk_support_ticket_drafts_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_drafts
  ADD CONSTRAINT "fk_support_ticket_drafts_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values DROP CONSTRAINT IF EXISTS "fk_support_ticket_custom_field_values_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values DROP CONSTRAINT IF EXISTS "fk_support_ticket_custom_field_values_field_definition_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_attachments DROP CONSTRAINT IF EXISTS "fk_support_ticket_attachments_message_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_activity DROP CONSTRAINT IF EXISTS "fk_support_ticket_activity_support_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_activity
  ADD CONSTRAINT "fk_support_ticket_activity_support_ticket_id_org"
  FOREIGN KEY (org_id, support_ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_message_mentions DROP CONSTRAINT IF EXISTS "fk_support_message_mentions_message_id_org";
--> statement-breakpoint
ALTER TABLE public.support_message_mentions
  ADD CONSTRAINT "fk_support_message_mentions_message_id_org"
  FOREIGN KEY (org_id, message_id)
  REFERENCES public.support_ticket_messages (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_knowledge_gaps DROP CONSTRAINT IF EXISTS "fk_support_knowledge_gaps_proposed_article_id_org";
--> statement-breakpoint
ALTER TABLE public.support_knowledge_gaps
  ADD CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org"
  FOREIGN KEY (org_id, proposed_article_id)
  REFERENCES public.kb_articles (org_id, id)
  ON DELETE SET NULL (proposed_article_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_csat_requests DROP CONSTRAINT IF EXISTS "fk_support_csat_requests_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_csat_requests
  ADD CONSTRAINT "fk_support_csat_requests_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ai_suggestions DROP CONSTRAINT IF EXISTS "fk_support_ai_suggestions_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ai_suggestions
  ADD CONSTRAINT "fk_support_ai_suggestions_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets DROP CONSTRAINT IF EXISTS "fk_sign_signature_assets_recipient_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets
  ADD CONSTRAINT "fk_sign_signature_assets_recipient_id_org"
  FOREIGN KEY (org_id, recipient_id)
  REFERENCES public.sign_recipients (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets DROP CONSTRAINT IF EXISTS "fk_sign_signature_assets_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets
  ADD CONSTRAINT "fk_sign_signature_assets_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_recipients DROP CONSTRAINT IF EXISTS "fk_sign_recipients_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_recipients
  ADD CONSTRAINT "fk_sign_recipients_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_public_forms DROP CONSTRAINT IF EXISTS "fk_sign_public_forms_template_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_public_forms
  ADD CONSTRAINT "fk_sign_public_forms_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.sign_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT IF EXISTS "fk_sign_fields_recipient_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "fk_sign_fields_recipient_id_org"
  FOREIGN KEY (org_id, recipient_id)
  REFERENCES public.sign_recipients (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT IF EXISTS "fk_sign_fields_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "fk_sign_fields_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT IF EXISTS "fk_sign_fields_document_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "fk_sign_fields_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.sign_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT IF EXISTS "fk_sign_envelopes_watermark_policy_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "fk_sign_envelopes_watermark_policy_id_org"
  FOREIGN KEY (org_id, watermark_policy_id)
  REFERENCES public.sign_watermark_policies (org_id, id)
  ON DELETE SET NULL (watermark_policy_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT IF EXISTS "fk_sign_envelopes_template_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "fk_sign_envelopes_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.sign_templates (org_id, id)
  ON DELETE SET NULL (template_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT IF EXISTS "fk_sign_envelopes_public_form_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "fk_sign_envelopes_public_form_id_org"
  FOREIGN KEY (org_id, public_form_id)
  REFERENCES public.sign_public_forms (org_id, id)
  ON DELETE SET NULL (public_form_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_documents DROP CONSTRAINT IF EXISTS "fk_sign_documents_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_documents
  ADD CONSTRAINT "fk_sign_documents_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_certificates DROP CONSTRAINT IF EXISTS "fk_sign_certificates_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_certificates
  ADD CONSTRAINT "fk_sign_certificates_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows DROP CONSTRAINT IF EXISTS "fk_sign_bulk_send_rows_job_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows
  ADD CONSTRAINT "fk_sign_bulk_send_rows_job_id_org"
  FOREIGN KEY (org_id, job_id)
  REFERENCES public.sign_bulk_send_jobs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows DROP CONSTRAINT IF EXISTS "fk_sign_bulk_send_rows_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows
  ADD CONSTRAINT "fk_sign_bulk_send_rows_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE SET NULL (envelope_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_jobs DROP CONSTRAINT IF EXISTS "fk_sign_bulk_send_jobs_template_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_jobs
  ADD CONSTRAINT "fk_sign_bulk_send_jobs_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.sign_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_audit_events DROP CONSTRAINT IF EXISTS "fk_sign_audit_events_recipient_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_audit_events
  ADD CONSTRAINT "fk_sign_audit_events_recipient_id_org"
  FOREIGN KEY (org_id, recipient_id)
  REFERENCES public.sign_recipients (org_id, id)
  ON DELETE SET NULL (recipient_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_audit_events DROP CONSTRAINT IF EXISTS "fk_sign_audit_events_envelope_id_org";
--> statement-breakpoint
ALTER TABLE public.sign_audit_events
  ADD CONSTRAINT "fk_sign_audit_events_envelope_id_org"
  FOREIGN KEY (org_id, envelope_id)
  REFERENCES public.sign_envelopes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.role_permission_grants DROP CONSTRAINT IF EXISTS "fk_role_permission_grants_role_id_org";
--> statement-breakpoint
ALTER TABLE public.role_permission_grants
  ADD CONSTRAINT "fk_role_permission_grants_role_id_org"
  FOREIGN KEY (org_id, role_id)
  REFERENCES public.roles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.purchase_bill_items DROP CONSTRAINT IF EXISTS "fk_purchase_bill_items_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.purchase_bill_items
  ADD CONSTRAINT "fk_purchase_bill_items_bill_id_org"
  FOREIGN KEY (org_id, bill_id)
  REFERENCES public.purchase_bills (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.principal_groups DROP CONSTRAINT IF EXISTS "fk_principal_groups_org_unit_id_org";
--> statement-breakpoint
ALTER TABLE public.policy_acknowledgments DROP CONSTRAINT IF EXISTS "fk_policy_acknowledgments_document_id_org";
--> statement-breakpoint
ALTER TABLE public.policy_acknowledgments
  ADD CONSTRAINT "fk_policy_acknowledgments_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
