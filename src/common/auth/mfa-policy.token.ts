import type { CurrentUserContext } from "./backend-claims";

export const MFA_POLICY = Symbol("MFA_POLICY");

export interface MfaState {
  enforced: boolean;
  satisfied: boolean;
}

export interface MfaSessionRef {
  sessionId: string;
  interactive: boolean;
}

export interface IMfaPolicy {
  resolve(
    orgId: string,
    userId: string,
    session: MfaSessionRef,
  ): Promise<MfaState>;
}

export function mfaSessionRefFor(user: CurrentUserContext): MfaSessionRef {
  const kind = user.principal.kind;
  return {
    sessionId: user.sessionId,
    interactive: kind === "human-session" || kind === "account-only",
  };
}
