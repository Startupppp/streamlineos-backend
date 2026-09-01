-- ROLLBACK_REFUSED: 0927 clears orphan/cross-tenant attribution values and
-- must not restore the retired tenant-unsafe single-column foreign keys.
SELECT '0927 rollback refused; use a forward corrective migration' AS rollback_refused;
