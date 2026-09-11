/**
 * What a brand-new workspace has in it before anybody types anything.
 *
 * Phase 3 ticket 13. A prospect who lands on an empty grid judges an empty grid:
 * they cannot tell whether the pipeline view is good, because there is no
 * pipeline in it. So signup seeds a small, plausible book of business.
 *
 * The whole difficulty is that ticket 14 defines "activated" as the workspace
 * holding **the tenant's own** data, at a threshold of ten records. A demo
 * dataset that counted toward that would report every workspace as activated on
 * the day it was created, and the one number the funnel is steered by would be
 * a number nobody could trust. Demo records therefore have to be
 * distinguishable from real ones, permanently and in the database, not by a
 * convention about creation time or by whoever remembers.
 *
 * ## How a demo record is marked
 *
 * One reserved provenance value, `streamline:demo`, written into the column each
 * table already keeps provenance in:
 *
 * - `business_parties.acquisition_source` — "where the relationship came from",
 *   and it came from us.
 * - `activities.source` — "`manual`, or the adapter that produced it".
 *
 * Both columns are tenant-open free text, which is exactly why the value is
 * namespaced: `demo` is something somebody might type, `streamline:demo` is not.
 *
 * `deals` has no provenance column at all, so a demo deal is recognised by the
 * customer it is with — every seeded deal is against a seeded party, and the
 * exclusion is a semi-join. That is weaker than a column and deliberately so:
 * adding one means a migration against `deals`, and the alternative on offer was
 * a reserved key inside `custom_data`, which is the tenant's own custom-field
 * store and would collide the first time somebody named a field "source". The
 * migration this wants is recorded on the ticket.
 *
 * Nothing here writes to the tables behind the other three activation signals —
 * members, imports and inbound events — because a demo dataset that fabricated a
 * completed import or a delivered message would be lying about a thing the
 * tenant is supposed to have done.
 */

/**
 * The reserved provenance value. Namespaced so a tenant cannot type it by
 * accident, and a constant so the seeder and the activation query cannot drift.
 */
export const DEMO_SOURCE = "streamline:demo";

/** The role every seeded company is given, so the CRM's role filters find them. */
export const DEMO_PARTY_ROLE = "CUSTOMER";

import { ACTIVITIES, DEALS, PARTIES, type DemoDataset } from "./demo-records";

/*
 * The shapes are declared beside the records rather than here, and re-exported,
 * so the dependency runs one way only: a type declared next to its consumer
 * would have to be imported back by the file that holds the values, and
 * `madge --circular` counts that.
 */
export type {
  DemoActivity,
  DemoDataset,
  DemoDeal,
  DemoParty,
  DemoPartyKind,
  DemoPartyType,
} from "./demo-records";

/**
 * The dataset, whole.
 *
 * A plain value rather than a builder: it is the same for every workspace, and
 * the only thing that varies at insert time is the ids.
 */
export function demoDataset(): DemoDataset {
  return { parties: PARTIES, deals: DEALS, activities: ACTIVITIES };
}
