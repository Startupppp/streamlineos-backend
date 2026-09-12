import type { MembershipArtifact } from "../membership-artifact.types";

export const NON_DATABASE_ARTIFACTS = [
  {
    id: "user_sessions",
    mechanism: "session-store",
    table: "user_sessions",
    keyedBy: "user_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "Sessions are account-global, so they are revoked only when this was the person's last active membership. Otherwise the membership cache bust closes this organization without signing them out of another.",
  },
  {
    id: "realtime_capability",
    mechanism: "realtime",
    table: null,
    keyedBy: "ably clientId = user_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "An Ably capability granting chat:${orgId}:* has a one-hour TTL and is not re-checked, so it outlives the membership unless it is explicitly withdrawn.",
  },
  {
    id: "user_integration_connections",
    mechanism: "provider",
    table: "user_integration_connections",
    keyedBy: "user_id + org_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "The mirror row is marked inside the revocation transaction and the provider disconnect is emitted to the outbox, so an outbound failure retries instead of silently leaving the connection live.",
  },
  {
    id: "access_caches",
    mechanism: "cache",
    table: null,
    keyedBy: "user_id + org_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "The resolved permission snapshot, the membership status entry and the account entry are what a request actually reads; without a bust the person keeps their old answer for the cache lifetime.",
  },
] as const satisfies readonly MembershipArtifact[];
