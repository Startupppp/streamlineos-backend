import { blockedProvider, type ProviderBlocked } from "../integrations/provider-blocked";

/**
 * Enterprise sign-on and directory sync for recruiters, stated honestly.
 *
 * The brief for this ticket assumed "recruiter SSO is org SSO if the platform
 * already has it". Measured on this codebase: it does not. There is no SAML or
 * per-tenant OIDC anywhere in either repository, no enforced-SSO setting, no
 * domain claim, and no SCIM endpoint of any kind — the only federated sign-in
 * is Google social login through NextAuth, which authenticates a Google
 * account rather than an organisation's directory.
 *
 * That distinction is the whole point. An admin who reads "SSO" and is given
 * Google sign-in believes deprovisioning a leaver in their IdP removes that
 * person's access here. It does not, and finding that out during an audit is
 * the harm. So both ship as explicit blocked states naming what exists and what
 * does not, rather than as a half-true "supported".
 *
 * `not-implemented` rather than `no-integration` for both: there is nothing an
 * administrator can connect, and telling them to check their settings would
 * send them looking for a switch that was never built.
 */

export type DirectoryCapability = "SSO" | "SCIM";

export interface DirectorySyncState {
  readonly capability: DirectoryCapability;
  readonly provider: ProviderBlocked;
  /** What the platform does have, so the answer is not only a refusal. */
  readonly availableToday: string;
}

export function directorySyncState(): DirectorySyncState[] {
  return [
    {
      capability: "SSO",
      provider: blockedProvider(
        "SSO",
        "not-implemented",
        "Single sign-on for recruiters",
        "Recruiters sign in with Google or an email link. Google sign-in authenticates a Google account, not your directory — removing somebody from your IdP does not remove their access here, so revoke the membership as well.",
      ),
      availableToday: "Google sign-in and magic-link sign-in, per user.",
    },
    {
      capability: "SCIM",
      provider: blockedProvider(
        "SCIM",
        "not-implemented",
        "SCIM directory provisioning",
        "Add and remove recruiters through Settings, or through the members API with a scoped token. There is no automatic provisioning from your directory.",
      ),
      availableToday: "Manual invitations and the members API.",
    },
  ];
}
