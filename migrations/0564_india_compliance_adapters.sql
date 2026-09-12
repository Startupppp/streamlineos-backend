-- E5 — the Indian statutory boundary: adapter flags and the documents they produce.
--
-- No GSTN, IRP, NIC or Tally connection exists. This is a boundary exercised
-- against a stub, not an integration exercised against a provider, and it makes
-- no compliance claim: a stub IRN is a rehearsal, not a filing.
--
-- Every flag defaults FALSE. An organisation that has not asked for e-invoicing
-- generates no outbound traffic and accumulates no documents describing filings
-- it never made — the service returns SKIPPED without constructing a payload, so
-- there is nothing to leak and nothing to clean up if the flag is set later.
--
-- The flags are separate from `pack_gst` deliberately. The pack decides whether
-- HSN codes and tax treatment exist as fields; these decide whether this
-- deployment talks to an authority. An organisation capturing HSN for its own
-- records and filing through its accountant wants the first and not the second.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "gst_einvoice_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "gst_ewaybill_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "tally_export_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "compliance_adapter" text DEFAULT 'stub' NOT NULL;
--> statement-breakpoint
-- One row per attempt at one statutory document, and the row is the audit: an
-- authority's acknowledgement is not something to reconstruct from a log line.
-- `raw_response` is stored verbatim rather than parsed into columns, because the
-- shape that matters in a dispute is the one the provider actually sent.
--
-- `adapter_is_live` is written at the time rather than derived from
-- `adapter_code` at read time: a deployment that later configures a real GSP
-- must not retroactively make its rehearsals look like filings.
CREATE TABLE IF NOT EXISTS "inv_compliance_documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "kind" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "document_number" text NOT NULL,
  "payload_hash" text NOT NULL,
  "adapter_code" text NOT NULL,
  "adapter_is_live" boolean DEFAULT false NOT NULL,
  "status" text NOT NULL,
  "external_id" text,
  "acknowledged_at" timestamp,
  "error_code" text,
  "error_message" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "raw_response" jsonb,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inv_compliance_documents"
  ADD CONSTRAINT "fk_inv_compliance_documents_org"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_compliance_documents" VALIDATE CONSTRAINT "fk_inv_compliance_documents_org";
--> statement-breakpoint
ALTER TABLE "inv_compliance_documents"
  ADD CONSTRAINT "fk_inv_compliance_documents_created_by"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_compliance_documents" VALIDATE CONSTRAINT "fk_inv_compliance_documents_created_by";
--> statement-breakpoint
-- The same document filed twice is one filing. An *edited* document hashes
-- differently and is therefore a different row, which is what stops an amended
-- invoice silently inheriting the original's IRN.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_compliance_doc"
  ON "inv_compliance_documents" ("org_id", "kind", "source_type", "source_id", "payload_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_compliance_org_source"
  ON "inv_compliance_documents" ("org_id", "source_type", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_compliance_org_status"
  ON "inv_compliance_documents" ("org_id", "status", "created_at");
