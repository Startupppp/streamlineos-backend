import type { Permission } from "./types";

export const CRM_PERMISSIONS: Permission[] = [
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
  {
    name: "crm:contacts:view",
    resource: "crm:contacts",
    action: "view",
    description: "View CRM contacts",
    scopable: true,
  },
  {
    name: "crm:contacts:manage",
    resource: "crm:contacts",
    action: "manage",
    description: "Manage CRM contacts",
  },
  {
    name: "crm:quotes:read",
    resource: "crm:quotes",
    action: "read",
    description: "View CRM quotes",
    scopable: true,
  },
  {
    name: "crm:quotes:create",
    resource: "crm:quotes",
    action: "create",
    description: "Create CRM quotes",
  },
  {
    name: "crm:quotes:update",
    resource: "crm:quotes",
    action: "update",
    description: "Update CRM quotes",
  },
  {
    name: "crm:quotes:delete",
    resource: "crm:quotes",
    action: "delete",
    description: "Delete CRM quotes",
  },
  {
    name: "crm:clients:manage",
    resource: "crm:clients",
    action: "manage",
    description: "Manage client accounts",
  },
  {
    name: "crm:assignment-rules:manage",
    resource: "crm:assignment-rules",
    action: "manage",
    description: "Manage lead assignment rules",
  },
  {
    name: "crm:email-templates:manage",
    resource: "crm:email-templates",
    action: "manage",
    description: "Manage CRM email templates",
  },
  {
    name: "crm:scoring-rules:manage",
    resource: "crm:scoring-rules",
    action: "manage",
    description: "Manage lead scoring rules",
  },
  {
    name: "crm:sla:manage",
    resource: "crm:sla",
    action: "manage",
    description: "Manage CRM SLA policies",
  },
  {
    name: "crm:organizations:view",
    resource: "crm:organizations",
    action: "view",
    description: "View CRM organizations",
  },
  {
    name: "crm:organizations:manage",
    resource: "crm:organizations",
    action: "manage",
    description: "Manage CRM organizations",
  },
  {
    name: "crm:web-forms:manage",
    resource: "crm:web-forms",
    action: "manage",
    description: "Manage CRM web forms",
  },
  {
    name: "crm:territories:manage",
    resource: "crm:territories",
    action: "manage",
    description: "Manage CRM territories",
  },
  {
    name: "crm:automations:manage",
    resource: "crm:automations",
    action: "manage",
    description: "Manage CRM automation rules",
  },
  {
    name: "crm:sequences:manage",
    resource: "crm:sequences",
    action: "manage",
    description: "Manage CRM email/call sequences",
  },
  {
    name: "crm:products:manage",
    resource: "crm:products",
    action: "manage",
    description: "Manage the CRM product catalog",
  },
  {
    name: "crm:pricebooks:manage",
    resource: "crm:pricebooks",
    action: "manage",
    description: "Manage price books and quote settings",
  },
  {
    name: "crm:quotes:approve",
    resource: "crm:quotes",
    action: "approve",
    description: "Approve or reject quotes requiring approval",
  },
  {
    name: "crm:contacts:merge",
    resource: "crm:contacts",
    action: "merge",
    description: "Merge duplicate CRM contacts",
  },
  {
    name: "crm:organizations:merge",
    resource: "crm:organizations",
    action: "merge",
    description: "Merge duplicate CRM organizations/companies",
  },
  {
    name: "crm:customer360:view",
    resource: "crm:customer360",
    action: "view",
    description:
      "View Customer 360 aggregated profile (respects per-module permissions)",
  },
  {
    // The seam every provider adapter posts into. Gated because an open ingress
    // writes parties and activities into any tenant that can be named.
    name: "crm:ingress:submit",
    resource: "crm:ingress",
    action: "submit",
    description: "Deliver a normalised inbound communication event into the CRM",
  },
  {
    name: "crm:activities:view",
    resource: "crm:activities",
    action: "view",
    description: "Read the unified timeline of calls, emails, meetings, notes and tasks",
  },
  {
    name: "crm:activities:manage",
    resource: "crm:activities",
    action: "manage",
    description: "Log, edit, complete and remove activities on the timeline",
  },
  {
    name: "crm:settings:view",
    resource: "crm:settings",
    action: "view",
    description:
      "View CRM configuration (pipelines, stages, options, validation rules, blueprints)",
  },
  {
    name: "crm:settings:manage",
    resource: "crm:settings",
    action: "manage",
    description:
      "Manage CRM configuration (pipelines, stages, options, validation rules, blueprints)",
  },
  {
    name: "crm:ai:use",
    resource: "crm:ai",
    action: "use",
    description:
      "Use CRM AI features (scoring, enrichment, briefs, email generation)",
  },
  {
    name: "crm:tasks:view",
    resource: "crm:tasks",
    action: "view",
    description: "View CRM tasks and inbox",
    scopable: true,
  },
  {
    name: "crm:tasks:update",
    resource: "crm:tasks",
    action: "update",
    description: "Update, complete, and snooze CRM tasks",
    scopable: true,
  },
  {
    name: "crm:campaigns:view",
    resource: "crm:campaigns",
    action: "view",
    description: "View CRM campaigns, attribution reports, and ROI metrics",
  },
  {
    name: "crm:campaigns:manage",
    resource: "crm:campaigns",
    action: "manage",
    description: "Create, update, and delete CRM campaigns",
  },
  {
    name: "crm:offer-fulfillment:view",
    resource: "crm:offer-fulfillment",
    action: "view",
    description: "View CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:create",
    resource: "crm:offer-fulfillment",
    action: "create",
    description: "Create CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:update",
    resource: "crm:offer-fulfillment",
    action: "update",
    description: "Update CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:delete",
    resource: "crm:offer-fulfillment",
    action: "delete",
    description: "Delete CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:autonomy:view",
    resource: "crm:autonomy",
    action: "view",
    description: "Review what the CRM decided and did on its own",
    // Scopable so a rep restricted to their own deals sees only the actions
    // taken on those, matching how the deals list narrows.
    scopable: true,
  },
  {
    name: "crm:autonomy:reverse",
    resource: "crm:autonomy",
    action: "reverse",
    description: "Reverse an autonomous CRM action",
  },
  {
    name: "crm:autonomy:manage",
    resource: "crm:autonomy",
    action: "manage",
    description: "Turn autonomous CRM action types on or off for the organisation",
  },
  {
    // Separate from `:manage`, which governs whether an action type runs at all.
    // This one governs whether the system may change stored customer data with
    // nobody watching, and that is a different thing to hand somebody.
    name: "crm:autonomy:repair",
    resource: "crm:autonomy",
    action: "repair",
    description:
      "Choose which classes of data problem the CRM may repair unattended, and run the repair loop",
  },
  {
    name: "crm:imports:manage",
    resource: "crm:imports",
    action: "manage",
    description: "Bring a CRM export into StreamlineOS, and take an import back out",
  },
  {
    name: "crm:issues:view",
    resource: "crm:issues",
    action: "view",
    description: "View internal issues, internal tasks and customer complaints",
    // Scopable so a member restricted to their own work sees the records they
    // own rather than the organisation's, matching how `crm:deals:read` narrows.
    scopable: true,
  },
  {
    name: "crm:issues:manage",
    resource: "crm:issues",
    action: "manage",
    description:
      "Raise, edit and move internal issues, internal tasks and customer complaints",
  },
  {
    // Separate from managing, because deciding that somebody's handling was not
    // good enough is a different authority from working the record — and one
    // that must be grantable without granting the other.
    name: "crm:issues:escalate",
    resource: "crm:issues",
    action: "escalate",
    description: "Escalate an issue, task or complaint above its owner",
  },
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
