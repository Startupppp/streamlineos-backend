# HRMS leave-opening backfill verifier

This artifact verifies the approved legacy opening-balance manifest without opening a database connection. Dry run is the only mode. `--apply` always fails with `LEAVE_OPENING_APPLY_UNAVAILABLE`.

The manifest is a strict JSON object with:

- `version: "v1"` and `kind: "hrms-leave-opening-backfill"`;
- `environment`, `database`, `databaseRole`, `approvalReference`, `expiresAt`, and `keyId`;
- `source: { rowCount: 5, totalBalance: "94.2000" }`;
- exactly two distinct reviewers, one `ORG_DATA_OWNER` and one `INDEPENDENT_HR_SECURITY`;
- exactly five entries containing only `sourceBalanceId`, `orgId`, `sourceUserId`, `sourceYear`, `sourceBalance`, `workerId`, `workerEngagementId`, `leaveTypeId`, `periodKey`, and `effectiveDate`.

Unknown fields are rejected. Names, emails, inferred dates, inferred periods, and inferred canonical mappings have no manifest field and therefore cannot be accepted.

The detached signature file is canonical standard base64 for the 64-byte Ed25519 signature over the exact raw manifest bytes. The verifier checks the independently supplied raw-file SHA-256, verifies the detached signature with the explicitly supplied PEM public key, derives the SHA-256 of its DER SPKI, and requires both the manifest and CLI `keyId` to equal `ed25519-sha256:<spki-sha256>`. The runtime has no private-key input.

Run from `backend`:

```text
node -r ts-node/register src/scripts/hrms-leave-opening-backfill/hrms-leave-opening-backfill.ts \
  --manifest=<manifest.json> \
  --manifest-sha256=<64-hex> \
  --signature=<signature.base64> \
  --public-key=<ed25519-public-key.pem> \
  --key-id=ed25519-sha256:<64-hex>
```

The report contains only operational IDs, counts, partition months, fingerprints, and deterministic command/source/operation keys. It excludes individual balances, full effective dates, manifest paths, and key material.

## Apply execution gate

Apply remains unavailable until a separately reviewed runner proves all of these in one transaction:

1. Connect through an explicit direct URL and prove `environment`, `current_database()`, and `current_user` match the signed manifest.
2. Acquire a global operation advisory lock and tenant locks in deterministic order.
3. Re-read all five source rows under the transaction snapshot and prove IDs, tenant, source user, type, year, each exact balance, count `5`, and total `94.2000` match.
4. Prove every signed worker, engagement, and leave type exists in the same tenant, and that the worker's canonical person belongs to the signed source user.
5. Prove every signed historical month has its exact range partition with correct bounds, RLS, policies, immutability/coherence triggers, FKs, and least-privilege grants.
6. Prove each permanent command and source key is absent, or already resolves to the byte-identical expected locator and fact; mixed or conflicting target state must fail.
7. Prove projection target rows are absent or exactly reconciled and lock them before any write.
8. Load the signed registry into a session-local table, set the manifest-bound local GUCs, and pass `preflight/02_leave_opening_balance_contract.sql` in the same session.
9. Insert locators, opening facts, and projections atomically; reconcile every row and total; prove the legacy source rows are unchanged; append the immutable migration audit record.
10. Roll back on any mismatch and pass tenant-isolation, rerun-idempotency, restore, lock-timeout, partition-routing, and failure-injection tests before production approval.

Until that runner and rehearsal evidence are approved, this verifier performs no write and does not read an environment database URL.
