DELETE FROM "integration_webhook_deliveries" iwd
WHERE EXISTS (
  SELECT 1 FROM "build"."webhook_deliveries" d
  WHERE d."org_id"      = iwd."org_id"
    AND d."webhook_id"  = iwd."build_webhook_id"
);
