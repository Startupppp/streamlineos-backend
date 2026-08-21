# HRMS Core Phase 1 SQL-managed bundle

Status: authored after the eight-decision approval, but review-only and not authorized for database execution until the remaining rehearsal and execution gates pass.

This directory is intentionally outside the normal Drizzle journal. Its SQL-managed partition parents, reciprocal deferred constraints, exclusion constraints, and per-leaf triggers cannot be represented truthfully by the current Drizzle snapshot chain. The empty custom-generation snapshots were removed and must never be copied into `migrations/meta`.

The bundle depends on root migration `0398` and runs only through the dedicated hash-allowlisted HRMS bundle runner. Before acquiring its advisory lock, the runner verifies local SQL hashes, the hash-bound approval manifest, target database identity, roles, environment, exact server-version range, and that `0398` is the latest applied Drizzle migration with the expected hash. Under the lock, each file transaction records `RUNNING` where the ledger already exists, runs the file's fail-closed preflight and DDL, records `VERIFYING`, verifies the exact catalog contract, and only then records `COMPLETE`; `0000` bootstraps its own `COMPLETE` row in the same transaction and is catalog-verified before commit. A failed transaction rolls back its in-flight state and records only a sanitized failure code separately. A safely rolled-back operation is retained as `ROLLED_BACK`; reapplication transitions that exact identity through `RUNNING` with an incremented attempt count. A failed reapplication is durably `FAILED` and requires a renewed manifest. The manifest hash proves exact file identity; it is not a digital signature.

Execution order:

1. `0000_hrms_profiles_workforce.sql`
2. `0001_hrms_effective_history.sql`
3. `0002_hrms_leave_ledger.sql`
4. `0003_hrms_attendance_events.sql`
5. `0004_hrms_hierarchy_audit.sql`
6. Create exact historical and current-plus-three range leaves with the hash-bound partition manifest.
7. Run deterministic backfills and reconciliation in approved tenant cohorts.
8. Validate existing-table `NOT VALID` constraints in separately monitored transactions.
9. Activate API writers/readers only through later canary migrations.

Fixed hash families use modulus 16. That physical choice and every exact range month remain manifest-bound promotion gates. Base migrations create no default or run-date-derived range partition.

The base wave grants the broad application role no writes to canonical facts, projections, migration maps, reconciliation, raw evidence, legal holds, or audit events. KMS, evidence reveal, retention, legal-hold, runtime fact-writer, and projection-writer privileges belong to later approved activation migrations.

Every down script refuses destructive rollback after canonical data exists. Populated canonical facts and history are retained; harmless additive columns and constraints on populated legacy tables may also remain rather than discard compatibility metadata. Rollback changes read/write modes through allowed adjacent profile transitions instead of erasing history.

Down files must not be run directly or with statement-level autocommit. The reviewed path is the bundle runner's `--rollback --rollback-through=<forward-file-name> --manifest=<rollback-approval> --manifest-sha256=<hash>` mode, with `--ack-production` additionally required in production. Its strict rollback approval binds the database and roles, root and server identities, expiry and approval, every applied file's exact operation ID and original apply-manifest hash, the rollback endpoint, and the exact ordered forward and down-file hashes. Under the same bundle advisory lock, it derives one unambiguous contiguous `COMPLETE` prefix and executes the approved reverse suffix one down file per transaction. Each transaction sets the same six bundle-operation GUCs, locks the exact `COMPLETE` row before any DDL, executes the entire down file, and commits only after its final transition to `ROLLED_BACK` and rolled-back catalog plus retained-ledger verification succeed.

Approval of the Phase 1 schema authoring decisions does not authorize production execution. Production remains blocked until a disposable production-size clone passes forward, rollback, catalog, RLS, role, partition-routing, reconciliation, and restore rehearsals and the exact manifest receives separate approval.
