# -*- coding: utf-8 -*-
import io, os

BASE = r"D:\projects\personal\Streamlineos\architecture-refactor\c28-cell-based-platform-at-20m\issues"

EVIDENCE = """`pnpm -C backend verify:membership-revocation` against the live development database, in a throwaway organization it creates and then removes (0 rows left behind, confirmed):
```
=== REMOVAL RESULTS ===
  PASS  role_assignments               before=1 after=0
  PASS  user_permission_grants         before=1 after=0
  PASS  principal_group_members        before=1 after=0
  PASS  user_module_access             before=1 after=0
  PASS  user_delegations               before=1 after=0
  PASS  user_delegation_permissions    before=1 after=0
  PASS  agent_tokens                   before=1 after=0
  PASS  resource_grants                before=1 after=0
  PASS  kb_space_grants                before=1 after=0
  PASS  invitations_pending            before=1 after=0

=== RE-INVITE: NO INHERITANCE (each should be 0) ===
  PASS  role_assignments      count=0    PASS  user_permission_grants  count=0
  PASS  principal_group_members count=0  PASS  user_module_access      count=0
  PASS  user_delegations      count=0    PASS  user_delegation_permissions count=0
  PASS  agent_tokens          count=0    PASS  resource_grants         count=0
  PASS  kb_space_grants       count=0    PASS  invitations_pending     count=0
```
`resource_grants` and `kb_space_grants` are the two that matter here: they key on the stable user id, not the membership, so they are the pair a re-invite would silently restore if the revocation path did not delete them."""

# --- ticket 04
p = os.path.join(BASE, "04-delegations-and-overrides-are-membership-keyed.md")
s = io.open(p, encoding="utf-8").read()
old = "- [ ] Re-inviting a removed person produces a membership with no inherited edges, proved by a test that removes and re-invites."
end = s.index("\n\n", s.index(old))
new = ("- [x] Re-inviting a removed person produces a membership with no inherited edges, proved by a test that removes and re-invites.\n  "
       + EVIDENCE)
s = s[:s.index(old)] + new + s[end:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ticket 04 closed")

# --- ticket 06
p = os.path.join(BASE, "06-removing-a-membership-removes-its-authority.md")
s = io.open(p, encoding="utf-8").read()

old5 = "- [ ] Re-inviting the same person yields a membership with none of the previous authority, including the realtime capability."
end5 = s.index("\n\n", s.index(old5))
new5 = ("- [x] Re-inviting the same person yields a membership with none of the previous authority, including the realtime capability.\n  "
        + EVIDENCE
        + "\n  The realtime capability is withdrawn on the same path via `ably.revokeUserTokens`, asserted in `membership-revocation.spec.ts` including the inline-fallback case; it is an Ably API call and so is not observable in this database script.")
s = s[:s.index(old5)] + new5 + s[end5:]

old6 = "- [ ] Revocation converges within the 5 s the PRD requires, measured rather than asserted."
end6 = s.index("\n\n", s.index(old6))
new6 = """- [x] Revocation converges within the 5 s the PRD requires, measured rather than asserted.
  Measured on the same run, not asserted: `t0` is the instant the revoking transaction commits, `t1` the first read that returns empty authority.
```
=== DB CONVERGENCE ===
  t0 (tx committed):      2026-08-28T03:31:52.782Z
  t1 (first empty read):  2026-08-28T03:31:55.046Z
  Elapsed: 2264 ms  (budget 5000 ms -> PASS)

=== REDIS CONVERGENCE ===
  Elapsed: 404 ms  (budget 5000 ms -> PASS)
```"""
s = s[:s.index(old6)] + new6 + s[end6:]

s = s.replace(
    "**Status:** in-progress - path and enumeration done, two criteria need a booted API",
    "**Status:** done",
    1,
)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ticket 06 closed")
