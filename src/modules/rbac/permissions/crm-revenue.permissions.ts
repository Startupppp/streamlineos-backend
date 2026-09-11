import type { Permission } from "./types";

/**
 * CRM catalog: customer lifecycle, renewal triggers, customer health, commission,
 * reporting and segments.
 *
 * One slice of `CRM_PERMISSIONS`. `crm.ts` spreads the slices in a fixed
 * order and that order is the catalog order; nothing imports a slice directly.
 */
export const CRM_REVENUE_PERMISSIONS: Permission[] = [
  {
    name: "crm:lifecycle:view",
    resource: "crm:lifecycle",
    action: "view",
    description:
      "Read the renewal book: which customer contracts come up when, what they are worth, and the signals behind each risk score",
    // Scopable so a rep restricted to their own deals sees the contracts those
    // deals produced, matching how `crm:deals:read` narrows. The book is
    // anchored to a deal, so the same narrowing is meaningful here.
    scopable: true,
  },
  {
    // Separate from viewing, and not folded into it. Reading who is up for
    // renewal is planning; recording that a customer renewed, churned, or is now
    // worth a different number changes what the company believes its recurring
    // revenue to be — and a signal moves the score that decides whose renewal
    // gets attention this week.
    name: "crm:lifecycle:manage",
    resource: "crm:lifecycle",
    action: "manage",
    description:
      "File a lifecycle signal, renew a customer contract into its next term, or close it as churned or cancelled",
  },
  {
    /*
      Reading the trigger log: which renewals opened a conversation, why, and
      what the outbound loop answered. Grouped with the book's own read rather
      than with the autonomy feed, because the question it answers is "is my
      renewal being worked" — a renewals question — and the feed's key governs a
      surface spanning every autonomous action the product takes.
    */
    name: "crm:lifecycle-triggers:view",
    resource: "crm:lifecycle-triggers",
    action: "view",
    description:
      "Read the renewal and churn trigger log: which contracts opened a renewal conversation, why, and what the outbound loop answered",
    // Scopable for the same reason `crm:lifecycle:view` is: the trigger is
    // anchored to a contract, which is anchored to a deal.
    scopable: true,
  },
  {
    /*
      Running a sweep, and deliberately NOT folded into `crm:lifecycle:manage`.

      What this key permits is not a record edit. A sweep opens opportunities in
      the pipeline, spends the tenant's AI credits drafting, and starts hold
      windows that end in mail leaving the building unless a human cancels them
      inside the window. A renewals administrator plainly needs to file signals
      and close terms; handing them the ability to start autonomous outbound as
      a side effect of that is how an organisation discovers the feature by
      receiving a complaint.
    */
    name: "crm:lifecycle-triggers:run",
    resource: "crm:lifecycle-triggers",
    action: "run",
    description:
      "Run a renewal sweep: open renewal opportunities for contracts that are due or at risk, and offer them to the autonomous outbound loop",
  },
  {
    // Reading a customer's health score AND the four inputs it decomposes into.
    // One key rather than two: a score without its factors is the thing the
    // feature exists to stop existing, so there is no reading of it that
    // excludes them.
    name: "crm:customer-health:view",
    resource: "crm:customer-health",
    action: "view",
    description:
      "Read customer health scores and the usage, engagement, support and sentiment inputs each one decomposes into",
    // Scopable so a rep restricted to their own accounts sees those customers'
    // health, matching how `crm:deals:read` narrows.
    scopable: true,
  },
  {
    // Recomputing writes: the assessment, its factor rows, and the score
    // projected onto `business_parties.health_score`, which a dozen other
    // screens render. Separate from viewing because overwriting what the whole
    // organisation reads as a customer's health is a different authority from
    // reading it.
    name: "crm:customer-health:manage",
    resource: "crm:customer-health",
    action: "manage",
    description:
      "Recompute a customer's health score from its sources and update the score shown on the customer record",
  },
  {
    /*
      Commission plans are a scheme document, not somebody's pay. A rep reading
      the bands they are measured against is the normal case, so this key is
      granted module-wide rather than narrowed; what a *person* earned is
      `crm:commission-earnings:view`, which is scopable for exactly that reason.
    */
    name: "crm:commission-plans:view",
    resource: "crm:commission-plans",
    action: "view",
    description:
      "Read commission plans, every dated version of their rules, and which version was in force on a date",
  },
  {
    /*
      The authority to define money. Separate from approving a payout so the
      person who set the rate need not also be the one who signs off the number
      it produced; an organisation wanting one person for both grants both.
    */
    name: "crm:commission-plans:manage",
    resource: "crm:commission-plans",
    action: "manage",
    description:
      "Create commission plans, publish a new dated version of their rules, and assign people to them",
  },
  {
    // Scopable, and the list route enforces it: at scope `own` a caller reads
    // only their own earnings, because a commission row is compensation and a
    // `?userId=` for a colleague would otherwise be an authorised salary leak.
    name: "crm:commission-earnings:view",
    resource: "crm:commission-earnings",
    action: "view",
    description: "Read commission earnings and the derivation behind each one",
    scopable: true,
  },
  {
    /*
      Looks like a read and is not one: computing an earning writes a ledger row
      and permanently seals the plan version it cited, after which that version
      can never be edited again.
    */
    name: "crm:commission-earnings:calculate",
    resource: "crm:commission-earnings",
    action: "calculate",
    description:
      "Compute what a won deal earned under the plan version in force on its close date",
  },
  {
    name: "crm:commission-earnings:approve",
    resource: "crm:commission-earnings",
    action: "approve",
    description: "Approve a calculated commission earning for payment",
  },
  {
    /*
      Rewriting the record of a payout's derivation, not reading it.

      Reading an accrual is deliberately gated on `crm:commission-earnings:view`
      instead of a key of its own: an accrual IS a set of earnings summed, and a
      key that granted the total while withholding the parts would be permission
      to see a figure nobody could check. Reusing that key also inherits its
      scoping, so a rep sees their own accrual and a manager at scope `all` sees
      the team's, with no second scope rule to keep in step with the first.

      This key exists for the one operation that is not a read. A rebuild deletes
      and rewrites the decomposition ledger and moves the curve people have been
      watching; it cannot change what anybody is paid, but it can change the
      published explanation of it. Whoever may read what they are owed is not
      therefore entitled to rewrite the record of how it was arrived at.

      Note the action is `rebuild` rather than `view` or `read`: those two
      suffixes are what `buildModuleMemberPermissionKeys` hands to every CRM
      member, and a member-held key to rewrite the commission ledger is not a
      thing this module should be able to acquire by naming.
    */
    name: "crm:commission-accruals:rebuild",
    resource: "crm:commission-accruals",
    action: "rebuild",
    description:
      "Re-derive the stored decomposition of commission earnings over a date range, without changing any amount",
  },
  {
    // Reading what has been asked, not asking. Covers the saved report list, one
    // report's definition, and the run log -- which is the auditor's read, and
    // deliberately grantable without the ability to run anything, because the
    // compiled statements in that log carry no tenant values.
    name: "crm:reporting:view",
    resource: "crm:reporting",
    action: "view",
    description: "View saved report definitions and the log of report runs",
  },
  {
    // Authoring. A saved definition is shared and is what other people will run,
    // so writing one is a different authority from reading the list. This also
    // gates the compile-only endpoint, which returns physical table and column
    // names and so tells the holder more than a report reader needs to know.
    name: "crm:reporting:manage",
    resource: "crm:reporting",
    action: "manage",
    description: "Create, edit and delete report definitions, and compile one without running it",
  },
  {
    // Executing. The only verb here that touches data, and the only one with a
    // cost -- so "may build reports" and "may pull the numbers" stay separable.
    //
    // Never sufficient on its own: every run also requires the permission that
    // governs the source's rows elsewhere in the product (`crm:deals:read`,
    // `crm:activities:view`, `party:parties:view`), checked in the service
    // because the source is known only after the body is parsed. Without that
    // second check this key would be a way to read what you were refused.
    name: "crm:reporting:run",
    resource: "crm:reporting",
    action: "run",
    description: "Run a report and return its rows",
  },
  {
    /*
      Reading segments, and evaluating them.

      Two keys where reporting has three, and the missing one is `run`. Reporting
      separates executing from authoring because a report run is unbounded work
      the tenant shapes -- arbitrary projections, grouping, a thousand rows -- so
      "may build reports" and "may pull the numbers" are worth granting apart. A
      segment's shape is fixed by the module: a capped sample and one aggregate.
      Evaluating one is what reading it means, so a third key would gate an
      operation nobody can usefully be denied while still being shown the
      segment, and an unusable key is how a catalogue starts lying about what it
      controls.

      Never sufficient on its own. Every read that touches rows also requires the
      key the registry declares on the source -- `party:parties:view` for parties
      -- checked in the service, because a guard can only check a constant and
      the source is known only after the body or the stored row is read. Without
      that second check this key would be a way to count and list the customers
      whose own screen refuses you.

      The action is `view`, so `buildModuleMemberPermissionKeys` hands it to
      `CRM_MODULE_MEMBER` along with every other CRM read. That is intended: a
      segment discloses nothing the party screen does not, because the party key
      is required on top of it.
    */
    name: "crm:segments:view",
    resource: "crm:segments",
    action: "view",
    description:
      "View saved CRM segments and evaluate one to see how many parties it matches and who they are",
  },
  {
    /*
      Authoring a segment.

      A separate authority from reading one for the reason a saved report's is: a
      segment is named, shared, and is what other people will target a campaign
      at, so writing one is an organisational act rather than a personal query. A
      badly drawn segment does not leak anything -- the party key still gates the
      rows -- but it becomes the definition of "our lapsed enterprise accounts"
      for everybody who reads it afterwards.

      `manage` rather than create/update/delete separately: the three are one
      job, done by one person on one screen, and splitting them would produce
      grants nobody assembles.
    */
    name: "crm:segments:manage",
    resource: "crm:segments",
    action: "manage",
    description: "Create, edit and delete CRM segments",
  },
];
