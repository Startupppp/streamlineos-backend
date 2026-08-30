SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inv_compliance_documents (
  id serial PRIMARY KEY,
  org_id text NOT NULL,
  kind text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  document_number text NOT NULL,
  payload_hash text NOT NULL,
  adapter_code text NOT NULL,
  adapter_is_live boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  external_id text,
  acknowledged_at timestamp without time zone,
  error_code text,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  raw_response jsonb,
  created_by text,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE inv_compliance_documents
  ADD CONSTRAINT fk_inv_compliance_documents_org
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE inv_compliance_documents
  VALIDATE CONSTRAINT fk_inv_compliance_documents_org;
--> statement-breakpoint
ALTER TABLE inv_compliance_documents
  ADD CONSTRAINT fk_inv_compliance_documents_created_by
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE inv_compliance_documents
  VALIDATE CONSTRAINT fk_inv_compliance_documents_created_by;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_compliance_org_source ON inv_compliance_documents(org_id, source_type, source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_compliance_org_status ON inv_compliance_documents(org_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_compliance_doc ON inv_compliance_documents(org_id, kind, source_type, source_id, payload_hash);
