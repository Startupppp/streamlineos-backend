-- Rollback for 0380_subscription_status_suspended.sql
--
-- WHAT THIS CAN DO:
--   Move any subscription rows currently in status='SUSPENDED' back to
--   status='CANCELLED' and stamp a metadata flag so the application can
--   distinguish them from intentional cancellations.
--
-- WHAT THIS CANNOT DO:
--   PostgreSQL has no ALTER TYPE ... REMOVE VALUE. The 'SUSPENDED' label
--   will remain in the pg_enum catalog permanently after the forward
--   migration is committed. This script is a data-layer rollback only.
--   If the code that writes status='SUSPENDED' is not also reverted, new
--   rows can still be written with that value and Postgres will accept them.
--
-- CAUTION — run the forward migration on 0381 and 0382 in reverse order
-- BEFORE running this script if all three were applied.

UPDATE subscriptions
SET
  status   = 'CANCELLED',
  metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'suspendedForNonPayment', true,
                  'rollbackFrom',          'SUSPENDED',
                  'rolledBackAt',          now()
                )
WHERE status = 'SUSPENDED';
