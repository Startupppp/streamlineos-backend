import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

// Birthdays and work anniversaries are a platform-core universal surface (root CLAUDE.md §8), so the unified calendar reads them org-wide for every active member.
export function organizationWideCelebrationsRead(actor: ScopeActor): ScopedRead {
  return ScopedRead.of(actor.orgId, actor.userId, "all");
}
