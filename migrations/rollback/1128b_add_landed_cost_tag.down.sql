-- Rollback for migration 1128b.
--
-- WARNING: NOT REVERSIBLE. The forward migration adds the value 'landed_cost'
-- to the existing enum "gl_system_tag" via ALTER TYPE … ADD VALUE. PostgreSQL
-- does not support removing a value from an enum once it has been committed;
-- the 'landed_cost' value is therefore permanent regardless of this rollback.
-- There is nothing structurally reversible in this migration — no table,
-- column, index or constraint was added. This file satisfies the rollback
-- convention and records the irreversibility, but it cannot undo the enum
-- extension.

SET lock_timeout = '5s';
