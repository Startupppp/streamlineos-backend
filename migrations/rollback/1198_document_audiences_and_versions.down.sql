-- Rollback for 1198_document_audiences_and_versions. Destructive: audiences and file history are lost.
-- Run 1199's rollback first: kb_linked_document_audiences is a subset of these audiences by contract.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."document_versions";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."document_audiences";
