-- CRM-P1-09. The clock the customer is actually reading.
--
-- `send-guardrails.resolveTimezone` has always preferred the party's zone over
-- the tenant's and reported which it used, and `crm_outbound_messages` records
-- `timezone_used` and `timezone_source` for every send. Nothing could ever set
-- the party half: no table recorded a zone, so `partyTimezone` was hardcoded
-- null and every working-hours decision was made in the sender's zone.
--
-- Nullable, and it stays nullable. An absent zone must keep falling through to
-- the tenant's rather than being defaulted or guessed from an address — a
-- confident wrong answer is what puts a message on somebody's phone at four in
-- the morning, which is the failure the gate exists to prevent.
--
-- No CHECK on the value: the set of valid IANA zones belongs to the runtime's
-- tzdata and changes without a migration. It is validated on write, and
-- `resolveTimezone` re-checks with `isKnownTimeZone` at send time, so a zone
-- that stops existing degrades to the tenant's rather than throwing.
SET lock_timeout = '5s';

ALTER TABLE business_parties
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN business_parties.timezone IS
  'IANA zone for this party, e.g. Asia/Kolkata. NULL means unknown: send-time working-hours checks fall back to the tenant zone rather than guessing.';
