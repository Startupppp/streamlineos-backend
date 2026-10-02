import { definePermissions } from "./types";

/**
 * CRM catalog: leads, targets, reports, data quality, call analysis and recording
 * consent, client read/update, incentives and deals.
 *
 * One slice of `CRM_PERMISSIONS`. `crm.ts` spreads the slices in a fixed
 * order and that order is the catalog order; nothing imports a slice directly.
 */
export const CRM_SALES_PERMISSIONS = definePermissions([
  {
    name: "crm:leads:view",
    resource: "crm:leads",
    action: "view",
    description: "View CRM leads",
    scopable: true,
  },
  {
    name: "crm:leads:create",
    resource: "crm:leads",
    action: "create",
    description: "Create CRM leads",
  },
  {
    name: "crm:leads:update",
    resource: "crm:leads",
    action: "update",
    description: "Update CRM leads",
    scopable: true,
  },
  {
    name: "crm:leads:assign",
    resource: "crm:leads",
    action: "assign",
    description: "Assign CRM leads",
  },
  {
    name: "crm:leads:delete",
    resource: "crm:leads",
    action: "delete",
    description: "Delete CRM leads",
    scopable: true,
  },
  {
    name: "crm:targets:view",
    resource: "crm:targets",
    action: "view",
    description: "View targets",
  },
  {
    name: "crm:targets:manage",
    resource: "crm:targets",
    action: "manage",
    description: "Manage targets",
  },
  {
    name: "crm:reports:view",
    resource: "crm:reports",
    action: "view",
    description: "View CRM reports",
  },
  {
    name: "crm:reports:export",
    resource: "crm:reports",
    action: "export",
    description: "Export CRM reports",
  },
  {
    name: "crm:data-quality:view",
    resource: "crm:data-quality",
    action: "view",
    description: "View CRM data quality dashboard",
  },
  {
    // Triage. Separate from resolving because deciding whose job a finding is
    // and changing four hundred customer records are different authorities.
    name: "crm:data-quality:assign",
    resource: "crm:data-quality",
    action: "assign",
    description: "Assign data quality findings to a person, or hand them back to the queue",
  },
  {
    name: "crm:data-quality:resolve",
    resource: "crm:data-quality",
    action: "resolve",
    description:
      "Resolve or dismiss data quality findings in bulk, reverse a resolution, and run the producers",
  },
  {
    // Reading what a call contained. Ends in `:view`, so a freshly seeded
    // CRM_MODULE_MEMBER gets it -- a rep is meant to read the analysis of their
    // own calls, and the backfill in 0541 grants the same to organisations that
    // already exist so capability does not depend on signup date.
    name: "crm:call-analysis:view",
    resource: "crm:call-analysis",
    action: "view",
    description:
      "Read the analysis of a completed call: talk ratio, question rate, objections and how they were handled, competitors named, and whether a next step was committed",
  },
  {
    // Separate from viewing, because this one spends the organisation's AI
    // credits. It is cheap by construction -- an already-analysed transcript
    // costs nothing -- but the first analysis of a call is a paid model call,
    // and "may read" and "may spend" are not the same authority.
    name: "crm:call-analysis:run",
    resource: "crm:call-analysis",
    action: "run",
    description:
      "Analyse a completed call's transcript. A transcript that has already been analysed is returned from cache and costs nothing",
  },
  {
    // Reading somebody else's call, and the manager side of the coaching digest.
    //
    // Deliberately NOT ending in `:view` or `:read`.
    // `buildModuleMemberPermissionKeys` hands every key with those suffixes to
    // `CRM_MODULE_MEMBER`, so a key called `crm:call-analysis:team-view` would
    // be granted to every rep at seed time and the whole team would read the
    // whole team's calls -- the leaderboard, arrived at through a naming
    // convention. `view-team` stops at the two admin rungs, which is the split
    // the ticket describes.
    //
    // Holding it does not make an analysis readable on its own: the rep's
    // private window in `call-analysis-visibility.ts` binds an org owner as
    // firmly as anyone else. This key says "you may be shown other people's
    // calls at all", not "you may be shown them now".
    name: "crm:call-analysis:view-team",
    resource: "crm:call-analysis",
    action: "view-team",
    description:
      "Read call analyses for calls you were not on, once the rep has shared one or their private window has elapsed, and see the team's coaching digest",
  },
  {
    // Asserting, for the record, that a call was lawfully recorded: where it
    // happened, and who agreed to it.
    //
    // Deliberately NOT ending in `:view` or `:read`, and here that is a
    // decision rather than a naming habit.
    // `buildModuleMemberPermissionKeys` hands every key with those suffixes to
    // `CRM_MODULE_MEMBER`, so a key called `crm:call-recording-consent:view`
    // would let every rep attest. A rep is the person who knows whether the
    // recording notice was played -- and also the person with a reason to say
    // it was when it was not, because the attestation is what unlocks the
    // analysis of their own call. A compliance assertion signed by the person
    // it benefits is not evidence of anything, so this stops at the two admin
    // rungs.
    //
    // Holding it does not let anybody skip the rule. There is no `:override`,
    // `:waive` or `:disable` key anywhere in this catalogue and there must
    // never be one: a permission that let an administrator bypass a two-party
    // consent jurisdiction would make a criminal-law constraint advisory. What
    // this key grants is the right to record evidence, which the rule then
    // reads -- see `call-recording-consent.ts`.
    name: "crm:call-recording-consent:attest",
    resource: "crm:call-recording-consent",
    action: "attest",
    description:
      "Record where a call took place and who consented to it being recorded, and read the ledger of calls the consent rule refused to analyse",
  },
  {
    name: "crm:clients:read",
    resource: "crm:clients",
    action: "read",
    description: "View client accounts",
    scopable: true,
  },
  {
    name: "crm:clients:update",
    resource: "crm:clients",
    action: "update",
    description: "Update client accounts",
  },
  {
    name: "crm:incentives:read",
    resource: "crm:incentives",
    action: "read",
    description: "View incentives",
  },
  {
    name: "crm:incentives:approve",
    resource: "crm:incentives",
    action: "approve",
    description: "Approve incentives",
  },
  {
    name: "crm:deals:read",
    resource: "crm:deals",
    action: "read",
    description: "View CRM deals",
    scopable: true,
  },
  {
    name: "crm:deals:create",
    resource: "crm:deals",
    action: "create",
    description: "Create CRM deals",
  },
  {
    name: "crm:deals:update",
    resource: "crm:deals",
    action: "update",
    description: "Update CRM deals",
  },
  {
    name: "crm:deals:delete",
    resource: "crm:deals",
    action: "delete",
    description: "Delete CRM deals",
  },
  {
    name: "crm:deals:approve",
    resource: "crm:deals",
    action: "approve",
    description: "Approve or reject deal stage transitions",
  },
  {
    name: "crm:deals:forecast",
    resource: "crm:deals",
    action: "forecast",
    description: "Capture and view forecast snapshots",
  },
  {
    name: "crm:deals:manage",
    resource: "crm:deals",
    action: "manage",
    description: "Manage deal forecasts and overrides",
  },
]);
