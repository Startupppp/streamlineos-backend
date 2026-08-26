-- c16-04: Back-fill invoice_items from invoices.line_items JSONB.
-- The invoice_items table was created alongside invoices from the first migration,
-- and the write service has dual-written since then. This migration covers any
-- older rows whose JSONB array was written before the table write was added.
-- It inserts one row per JSON element where no invoice_items row already exists.
-- 0478 drops the column only after this back-fill is verified.

SET lock_timeout = '5s';

INSERT INTO invoice_items (invoice_id, description, hsn_sac_code, quantity, rate, gst_rate, amount, line_order)
SELECT
  i.id                                                          AS invoice_id,
  COALESCE(elem->>'description', '')                            AS description,
  NULL::text                                                    AS hsn_sac_code,
  COALESCE((elem->>'quantity')::numeric, 1)                     AS quantity,
  COALESCE((elem->>'rate')::numeric, 0)                         AS rate,
  0::numeric(5,2)                                               AS gst_rate,
  COALESCE((elem->>'amount')::numeric, 0)                       AS amount,
  (idx - 1)::int                                                AS line_order
FROM invoices i
CROSS JOIN LATERAL jsonb_array_elements(i.line_items) WITH ORDINALITY AS arr(elem, idx)
WHERE jsonb_array_length(COALESCE(i.line_items, '[]'::jsonb)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id
  );
