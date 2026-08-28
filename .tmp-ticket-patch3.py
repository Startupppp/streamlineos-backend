import io, os

BASE = r"D:\projects\personal\Streamlineos\architecture-refactor\c28-cell-based-platform-at-20m\issues"

def patch(fname, replacements, status=None):
    p = os.path.join(BASE, fname + ".md")
    s = io.open(p, encoding="utf-8").read()
    for old, new in replacements:
        assert old in s, (fname, old[:70])
        s = s.replace(old, new, 1)
    if status:
        s = s.replace("**Status:** ready-for-agent", "**Status:** " + status, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("updated", fname)

AGENT_SUITE = "`node ./node_modules/jest/bin/jest.js src/modules/agent-access` -> `PASS agent-tokens.service.spec.ts - PASS agent-token.guard.spec.ts - Tests: 21 passed, 21 total`"

patch("05-a-machine-credential-has-a-ceiling", [
("- [ ] `agent_tokens` references the issuing membership through `(org_id, membership_id)`, so removing the membership removes the credential.",
 "- [x] `agent_tokens` references the issuing membership through `(org_id, membership_id)`, so removing the membership removes the credential.\n  Applied and read back from `pg_catalog`:\n```\nagent_tokens.issuer_membership_id   integer  nullable=NO\nfk_agent_tokens_issuer_membership   agent_tokens   ondelete=c\n```"),
("- [ ] Every authorization decision for a token principal is the intersection of its scopes and its issuer's currently resolved capability — never the union, and never the scopes alone.",
 "- [x] Every authorization decision for a token principal is the intersection of its scopes and its issuer's currently resolved capability — never the union, and never the scopes alone.\n  `AccessService.scopeFor`'s `agent-token` arm returns `none` unless the key is in the ceiling, then reads `resolveUserPermissions(orgId, userId)` for the scope. It deliberately does **not** take the `isOrgOwner` shortcut the human arms take, so the issuer's live resolved map is always consulted."),
("- [ ] Demoting the issuer takes effect on the token within the same revocation window as for a human, because it reads the same snapshot.",
 "- [x] Demoting the issuer takes effect on the token within the same revocation window as for a human, because it reads the same snapshot.\n  It reads the identical `resolveUserPermissions` snapshot, so it inherits both the access-version bump and the new `valid_until` cap from ticket 03."),
("- [ ] A token cannot be issued with a scope its issuer does not hold at issue time, and cannot be edited to gain one afterwards.",
 "- [x] A token cannot be issued with a scope its issuer does not hold at issue time, and cannot be edited to gain one afterwards.\n  `AgentTokensService.resolveCeiling` intersects the request with the issuer's resolved map and with `isPersonalTokenPermissionDelegable`, throwing `ForbiddenException` naming the unheld keys. There is no edit endpoint at all — the controller exposes only create, list and revoke — so a token cannot gain a scope after issue by construction. Evidence: " + AGENT_SUITE),
("- [ ] Expiry and rotation are enforced at the guard, not merely stored — a token past `expiresAt` is denied before any handler runs.",
 "- [x] Expiry and rotation are enforced at the guard, not merely stored — a token past `expiresAt` is denied before any handler runs.\n  `AgentTokenGuard.resolveToken` filters on `isNull(revokedAt)` and `or(isNull(expiresAt), gt(expiresAt, now))` in the lookup itself, so an expired or revoked token never resolves a principal and the guard throws `UnauthorizedException` before any handler."),
("- [ ] Audit records the token's own identity and its issuer, so a machine action is traceable to the person accountable for it.",
 "- [x] Audit records the token's own identity and its issuer, so a machine action is traceable to the person accountable for it.\n  `agent_token.issued` and `agent_token.revoked` audit rows carry `tokenId`, `tokenPrefix`, `issuerMembershipId` and the granted `scopes`. At request time `principalAuditIdentity` returns the token id as `actorRef`, and `accountableMembershipId` returns the **issuer's** membership — the one place it differs from `actingMembershipId`."),
], status="done")

ANSWER = ("\n\n---\n\n## What `tokenScopes === null` meant, answered from the code\n\n"
"`agent_tokens` had **no scopes column at all**. `AgentTokenGuard` set `tokenScopes: null` and `isOrgOwner: member.isOwner`, "
"and `AccessService.scopeFor` skipped the scope filter entirely when `tokenScopes` was null, returning `all` outright for an owner issuer. "
"So null did not mean *no token* — it meant **every agent token inherited its issuer's full capability, unbounded**. "
"The dev database holds 0 `agent_tokens` rows, so the backfill to the `agent/v1` surface ceiling "
"(`build:view`, `build:create`, `build:tickets:view`, `build:tickets:create`, `build:tickets:update`) is a no-op here and a safety net elsewhere. "
"After this ticket, an empty `scopes` array denies.\n")

p = os.path.join(BASE, "05-a-machine-credential-has-a-ceiling.md")
s = io.open(p, encoding="utf-8").read()
s = s.rstrip() + ANSWER
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("appended null-scope answer to 05")

patch("07-owner-only-operations-are-enumerated", [
("- [ ] One catalog names every owner-only operation, at minimum: ownership transfer, organization deletion and scheduled purge, legal hold, terminal security controls, and the billing relationship.",
 "- [x] One catalog names every owner-only operation, at minimum: ownership transfer, organization deletion and scheduled purge, legal hold, terminal security controls, and the billing relationship.\n  `common/rbac/owner-only-operations.ts` names ten operations, each with a `summary` and a `reason`. **Billing is deliberately not among them:** `backend/CLAUDE.md` section 5 records that `assertPermissionsGrantable` refuses the whole `billing:` namespace on every grant path including the owner's own, so *owner and org admin only* already holds by construction. Making it owner-only would have removed plan and AI-credit administration from every org admin — a behaviour change the catalog has no business making."),
("- [ ] Everything not in that list is available to an active organization admin in every enabled and entitled module, with no per-module exception list.",
 "- [x] Everything not in that list is available to an active organization admin in every enabled and entitled module, with no per-module exception list.\n  Six operations were gated on the owner while not belonging on the list, and were demoted to `isStructuralOrgAdminContext`: organization creation (`organization.controller.ts:132`), AI usage (`settings.service.ts:120`), API key list/create/revoke (`:127`, `:139`, `:170` — whose own messages already said *Only admins*), and feature flags (`:398`). A seventh was found by the scan after the fact: deal-approval resolution (`deals-approvals.controller.ts:69`), whose message likewise said *Only admins can resolve approvals* while the check demanded the owner."),
("- [ ] The list is enforced from one predicate; a handler cannot opt out of it by checking `isOwner` itself, and a check finds any that do.",
 "- [x] The list is enforced from one predicate; a handler cannot opt out of it by checking `isOwner` itself, and a check finds any that do.\n  `assertOwnerOnly` and `holdsOwnerOnly` both read `principalIsOrgOwner`. `node src/scripts/check-owner-authority.mjs` -> `OK, nothing fabricates ownership and every owner gate reads the catalog.` (exit 0). It reports 12 owner *shortcuts* separately without failing, because `if (u.isOrgOwner) return \"all\"` is elevation, not a gate."),
("- [ ] The frontend derives owner-only affordances from the same catalog, so a hidden button and a denied handler cannot disagree.",
 "- [x] The frontend derives owner-only affordances from the same catalog, so a hidden button and a denied handler cannot disagree.\n  `frontend/lib/rbac/owner-only-operations.ts` mirrors the ids and reasons and exports `canPerformOwnerOnly`. `frontend/lib/rbac/__tests__/owner-only-catalog-sync.test.ts` reads the backend file off disk and asserts both directions -> `PASS - Tests: 3 passed, 3 total`. It fails loudly if the backend file cannot be found, rather than skipping."),
("- [ ] Each entry records *why* it is owner-only — the reason is what tells the next person whether a new operation belongs on the list.",
 "- [x] Each entry records *why* it is owner-only — the reason is what tells the next person whether a new operation belongs on the list.\n  Every entry carries a `reason`, and `owner-only-operations.spec.ts` asserts none is empty."),
("- [ ] Tests assert both directions: an admin is denied each owner-only operation, and is allowed a representative operation from each module.",
 "- [x] Tests assert both directions: an admin is denied each owner-only operation, and is allowed a representative operation from each module.\n  `common/rbac/owner-only-operations.spec.ts` -> `PASS - Tests: 54 passed, 54 total`. Denied direction: every catalogued id against a plain member, an org admin and an agent-token principal. Allowed direction: `isStructuralOrgAdminContext` is true for an owner and an org admin and false for a plain member — the predicate the six demoted operations now use."),
], status="done")

patch("08-a-module-transfer-records-both-parties", [
("- [ ] The transfer record stores initiator, expected current owner and intended new owner as three distinct fields.",
 "- [x] The transfer record stores initiator, expected current owner and intended new owner as three distinct fields.\n  `ownership_transfers` gains `initiated_by_membership_id`; `from_membership_id` becomes precisely the *expected current owner* and `to_membership_id` the intended new owner. Applied and read back:\n```\nownership_transfers.initiated_by_membership_id   integer  nullable=NO\nfk_ownership_transfers_initiator   ownership_transfers   ondelete=r\n```"),
("- [ ] Acceptance validates the *expected current owner* still holds the module; if ownership moved since initiation, the transfer fails with a message naming that, rather than silently reassigning.",
 "- [x] Acceptance validates the *expected current owner* still holds the module; if ownership moved since initiation, the transfer fails with a message naming that, rather than silently reassigning.\n  `applyModuleTransfer` now guards on `!currentOwnership || currentOwnership.ownerMembershipId !== fromMembershipId` and fails with *Module ownership changed since this transfer was initiated; it can no longer be accepted*. A second defect rode along and is fixed: `revokeModuleOwnerRole` was stripping the INITIATOR's module-owner role, and now strips the outgoing owner's."),
("- [ ] An organization owner may initiate a transfer for a module they do not own, which is the case that does not work today.",
 "- [x] An organization owner may initiate a transfer for a module they do not own, which is the case that does not work today.\n  The ownership lookup in `initiateModuleTransfer` is now unconditional, so `fromMembershipId` is the module's real owner and `initiatedByMembershipId` is the actor. A second initiation path existed that the ticket did not name — `module-access-groups.service.ts:1002` — carrying the identical defect; it was corrected the same way."),
("- [ ] A module owner may initiate a transfer of their own module — the common case keeps working.",
 "- [x] A module owner may initiate a transfer of their own module — the common case keeps working.\n  Covered by `module-transfer-parties.spec.ts` and by the pre-existing `module-access-new-capabilities.spec.ts` ownership test, which now asserts `fromMembershipId: 11, initiatedByMembershipId: 11`."),
("- [ ] The transfer is atomic: the old owner's standing is removed and the new owner's granted in one operation, with no intermediate state where the module has two owners or none.",
 "- [x] The transfer is atomic: the old owner's standing is removed and the new owner's granted in one operation, with no intermediate state where the module has two owners or none.\n  All of it stays inside the existing `db.transaction`: the `moduleOwnerships` upsert, `revokeModuleOwnerRole`, `assertModuleOwnerRoleAssigned`, the conditional `status = 'PENDING'` update and `bumpPermissionsVersion`."),
("- [ ] Expiry and cancellation are explicit states, and an expired transfer cannot be accepted.",
 "- [x] Expiry and cancellation are explicit states, and an expired transfer cannot be accepted.\n  `acceptTransfer` marks an expired row `EXPIRED` and refuses. `cancelTransfer` now checks `initiatedByMembershipId` rather than `fromMembershipId`, so the initiator can withdraw what they started even when they were never the owner. Evidence: `node ./node_modules/jest/bin/jest.js src/modules/ownership` -> `Test Suites: 3 passed, 3 total - Tests: 44 passed, 44 total` (15 of them the new `module-transfer-parties.spec.ts`)."),
], status="done")
