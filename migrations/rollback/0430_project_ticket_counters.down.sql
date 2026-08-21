-- Rollback for 0430. Callers revert to MAX(ticket_number)+1; no ticket data is touched.
DROP TABLE IF EXISTS "project_ticket_counters";
