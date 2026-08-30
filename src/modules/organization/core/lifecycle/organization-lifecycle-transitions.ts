import type { OrganizationSagaKind } from "../../../../db/schema/common/organization-lifecycle";

export type OrgStatus = "ACTIVE" | "ARCHIVED" | "PURGE_SCHEDULED" | "PURGED";

type TransitionDef = {
  readonly allowedFrom: readonly OrgStatus[] | null;
  readonly resultingStatus: OrgStatus | null;
  readonly blockedByLegalHold: boolean;
};

export const TRANSITION_TABLE: Readonly<Record<OrganizationSagaKind, TransitionDef>> = {
  CREATE: {
    allowedFrom: null,
    resultingStatus: "ACTIVE",
    blockedByLegalHold: false,
  },
  ARCHIVE: {
    allowedFrom: ["ACTIVE"],
    resultingStatus: "ARCHIVED",
    blockedByLegalHold: false,
  },
  RESTORE: {
    allowedFrom: ["ARCHIVED"],
    resultingStatus: "ACTIVE",
    blockedByLegalHold: false,
  },
  EXPORT: {
    allowedFrom: ["ACTIVE", "ARCHIVED"],
    resultingStatus: null,
    blockedByLegalHold: false,
  },
  OWNERSHIP_TRANSFER: {
    allowedFrom: ["ACTIVE"],
    resultingStatus: null,
    blockedByLegalHold: false,
  },
  PURGE_SCHEDULE: {
    allowedFrom: ["ACTIVE", "ARCHIVED"],
    resultingStatus: "PURGE_SCHEDULED",
    blockedByLegalHold: true,
  },
  PURGE_CANCEL: {
    allowedFrom: ["PURGE_SCHEDULED"],
    resultingStatus: "ACTIVE",
    blockedByLegalHold: false,
  },
  LEGAL_HOLD: {
    allowedFrom: ["ACTIVE"],
    resultingStatus: null,
    blockedByLegalHold: false,
  },
  LEGAL_HOLD_RELEASE: {
    allowedFrom: ["ACTIVE"],
    resultingStatus: null,
    blockedByLegalHold: false,
  },
  TERMINAL_DELETE: {
    allowedFrom: ["ACTIVE", "ARCHIVED"],
    resultingStatus: null,
    blockedByLegalHold: true,
  },
};

export type TransitionAllowedResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function assertTransitionAllowed(
  kind: OrganizationSagaKind,
  fromStatus: OrgStatus | null,
  opts: { hasActiveLegalHold: boolean },
): TransitionAllowedResult {
  const def = TRANSITION_TABLE[kind];

  if (def.blockedByLegalHold && opts.hasActiveLegalHold) {
    return {
      allowed: false,
      reason: `${kind} is blocked by an active legal hold`,
    };
  }

  if (def.allowedFrom === null) {
    if (fromStatus !== null) {
      return {
        allowed: false,
        reason: `${kind} requires no existing organization but got status ${fromStatus}`,
      };
    }
    return { allowed: true };
  }

  if (fromStatus === null) {
    return {
      allowed: false,
      reason: `${kind} requires an existing organization but no status was provided`,
    };
  }

  if (!(def.allowedFrom as readonly string[]).includes(fromStatus)) {
    return {
      allowed: false,
      reason: `${kind} is not allowed from status ${fromStatus}; allowed: ${def.allowedFrom.join(", ")}`,
    };
  }

  return { allowed: true };
}

export const SAGA_STEPS: Readonly<Record<OrganizationSagaKind, readonly string[]>> = {
  CREATE: [
    "reserve-identity",
    "reserve-placement",
    "bootstrap-cell-organization",
    "bootstrap-owner-membership",
    "activate-directory-projection",
  ],
  ARCHIVE: [
    "revoke-invitations",
    "set-status-archived",
    "revoke-member-access",
  ],
  RESTORE: ["set-status-active"],
  EXPORT: ["snapshot-org-data"],
  OWNERSHIP_TRANSFER: ["validate-new-owner", "transfer-ownership"],
  PURGE_SCHEDULE: ["validate-no-legal-hold", "set-status-purge-scheduled"],
  PURGE_CANCEL: ["set-status-active"],
  LEGAL_HOLD: ["record-legal-hold"],
  LEGAL_HOLD_RELEASE: ["validate-hold-exists", "release-legal-hold"],
  TERMINAL_DELETE: [
    "validate-confirmation",
    "validate-no-legal-hold",
    "delete-org-data",
    "remove-placement",
  ],
};
