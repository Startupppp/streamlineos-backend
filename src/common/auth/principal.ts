import { type SystemJobId, systemJobCeiling } from "./system-jobs";
import { assertNever } from "../types/assert-never";

export type Principal =
  | {
      kind: "human-session";
      membershipId: number;
      isOrgOwner: boolean;
    }
  | {
      kind: "account-only";
    }
  | {
      kind: "personal-token";
      membershipId: number;
      isOrgOwner: boolean;
      tokenId: string;
      ceiling: readonly string[];
    }
  | {
      kind: "agent-token";
      issuerMembershipId: number;
      tokenId: number;
      ceiling: readonly string[];
    }
  | {
      kind: "system-job";
      jobId: SystemJobId;
      ceiling: readonly string[];
    };

export type PrincipalKind = Principal["kind"];

export const ACCOUNT_ONLY_PRINCIPAL: Principal = { kind: "account-only" };

export function humanSessionPrincipal(
  membershipId: number,
  isOrgOwner: boolean,
): Principal {
  return { kind: "human-session", membershipId, isOrgOwner };
}

export function personalTokenPrincipal(
  membershipId: number,
  isOrgOwner: boolean,
  tokenId: string,
  ceiling: readonly string[],
): Principal {
  return { kind: "personal-token", membershipId, isOrgOwner, tokenId, ceiling };
}

export function agentTokenPrincipal(
  issuerMembershipId: number,
  tokenId: number,
  ceiling: readonly string[],
): Principal {
  return { kind: "agent-token", issuerMembershipId, tokenId, ceiling };
}

export function systemJobPrincipal(jobId: SystemJobId): Principal {
  return { kind: "system-job", jobId, ceiling: systemJobCeiling(jobId) };
}

export function actingMembershipId(principal: Principal): number | null {
  switch (principal.kind) {
    case "human-session":
    case "personal-token":
      return principal.membershipId;
    case "account-only":
    case "agent-token":
    case "system-job":
      return null;
    default:
      return assertNever(principal);
  }
}

export function accountableMembershipId(principal: Principal): number | null {
  if (principal.kind === "agent-token") return principal.issuerMembershipId;
  return actingMembershipId(principal);
}

export function principalIsOrgOwner(principal: Principal): boolean {
  switch (principal.kind) {
    case "human-session":
    case "personal-token":
      return principal.isOrgOwner;
    case "account-only":
    case "agent-token":
    case "system-job":
      return false;
    default:
      return assertNever(principal);
  }
}

export function principalCeiling(
  principal: Principal,
): readonly string[] | null {
  switch (principal.kind) {
    case "human-session":
    case "account-only":
      return null;
    case "personal-token":
    case "agent-token":
    case "system-job":
      return principal.ceiling;
    default:
      return assertNever(principal);
  }
}

export function systemJobCovers(
  principal: Principal,
  permissionKey: string,
): boolean {
  return (
    principal.kind === "system-job" && principal.ceiling.includes(permissionKey)
  );
}

export interface PrincipalAuditIdentity {
  actorKind: PrincipalKind;
  actorRef: string | null;
}
