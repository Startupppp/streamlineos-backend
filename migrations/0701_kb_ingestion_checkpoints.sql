SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "kb_ingestion_checkpoints" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "content_type" text NOT NULL,
  "content_id" integer NOT NULL,
  "content_hash" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "kb_ingestion_checkpoints_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_ingestion_checkpoint" ON "kb_ingestion_checkpoints" ("org_id","content_type","content_id","chunk_index");
--> statement-breakpoint
CREATE INDEX "idx_kb_ingestion_checkpoint_lookup" ON "kb_ingestion_checkpoints" ("org_id","content_type","content_id","content_hash");
--> statement-breakpoint
ALTER TABLE "kb_ingestion_checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $policy$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'kb_ingestion_checkpoints' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY "tenant_isolation" ON "kb_ingestion_checkpoints"
      AS PERMISSIVE FOR ALL
      TO public
      USING (org_id = app.current_org_id())
      WITH CHECK (org_id = app.current_org_id());
  END IF;
END $policy$;
