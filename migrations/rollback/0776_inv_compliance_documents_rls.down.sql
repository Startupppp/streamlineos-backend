-- 0776.down — Remove tenant isolation from inv_compliance_documents.
--
-- As with 0514: this reverses a security control. Compliance documents carry
-- e-invoice and e-way-bill payloads, so running this leaves one tenant's filings
-- readable by another. Only meaningful inside a descent that continues past it.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_compliance_documents";
--> statement-breakpoint
ALTER TABLE "inv_compliance_documents" DISABLE ROW LEVEL SECURITY;
