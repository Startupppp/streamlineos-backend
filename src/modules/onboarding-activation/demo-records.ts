/**
 * The sample book of business itself.
 *
 * Content and the shapes it takes, kept apart from `demo-dataset.ts` so the rule
 * about what makes a record a demo record is readable without scrolling past two
 * hundred lines of fixture. Nothing here decides anything; it is the thing the
 * marker is applied to.
 *
 * Twelve parties is not arbitrary: ticket 14 treats ten as the point at which a
 * workspace holds real data, so the dataset is deliberately on the far side of
 * the line the exclusion has to hold. Shrink it below that and the exclusion
 * stops being load-bearing, which `demo-dataset.spec.ts` will say out loud.
 */

export type DemoPartyKind = "PERSON" | "ORGANISATION";
export type DemoPartyType = "CUSTOMER" | "VENDOR" | "PARTNER" | "BOTH";

export interface DemoParty {
  /** Stable within the dataset; the real id is allocated at insert time. */
  readonly key: string;
  readonly name: string;
  readonly partyKind: DemoPartyKind;
  readonly partyType: DemoPartyType;
  readonly lifecycleStage: string;
  readonly email: string;
  readonly phone: string;
  readonly city: string;
  readonly industry: string;
  readonly companyName?: string;
  readonly jobTitle?: string;
  readonly tags: readonly string[];
}

export interface DemoDeal {
  readonly key: string;
  /** Always a party in this dataset: it is how a demo deal is recognised. */
  readonly partyKey: string;
  readonly name: string;
  readonly valueMinor: number;
  readonly stage: string;
  readonly probability: number;
  readonly closesInDays: number;
  readonly nextStep: string;
}

export interface DemoActivity {
  readonly key: string;
  /** Exactly one anchor, matching `chk_activities_one_anchor`. */
  readonly anchor: { readonly party: string } | { readonly deal: string };
  readonly kind: "call" | "email" | "meeting" | "note" | "task";
  readonly subject: string;
  readonly body: string;
  readonly daysAgo: number;
}

export interface DemoDataset {
  readonly parties: readonly DemoParty[];
  readonly deals: readonly DemoDeal[];
  readonly activities: readonly DemoActivity[];
}

export const PARTIES: readonly DemoParty[] = [
  {
    key: "northwind",
    name: "Northwind Logistics",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "CUSTOMER",
    email: "accounts@northwind.example",
    phone: "+44 20 7946 0101",
    city: "Manchester",
    industry: "Logistics",
    tags: ["sample"],
  },
  {
    key: "kestrel",
    name: "Kestrel Manufacturing",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "QUALIFIED",
    email: "procurement@kestrel.example",
    phone: "+44 121 496 0102",
    city: "Birmingham",
    industry: "Manufacturing",
    tags: ["sample"],
  },
  {
    key: "harbour",
    name: "Harbour & Finch",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "CUSTOMER",
    email: "hello@harbourfinch.example",
    phone: "+44 131 496 0103",
    city: "Edinburgh",
    industry: "Professional services",
    tags: ["sample"],
  },
  {
    key: "meridian",
    name: "Meridian Health Group",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "CONTACTED",
    email: "partnerships@meridianhealth.example",
    phone: "+44 29 2018 0104",
    city: "Cardiff",
    industry: "Healthcare",
    tags: ["sample"],
  },
  {
    key: "orchard",
    name: "Orchard Retail",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "NEW",
    email: "buying@orchardretail.example",
    phone: "+44 113 496 0105",
    city: "Leeds",
    industry: "Retail",
    tags: ["sample"],
  },
  {
    key: "quarry",
    name: "Quarry Bay Consulting",
    partyKind: "ORGANISATION",
    partyType: "PARTNER",
    lifecycleStage: "CUSTOMER",
    email: "team@quarrybay.example",
    phone: "+44 20 7946 0106",
    city: "London",
    industry: "Consulting",
    tags: ["sample"],
  },
  {
    key: "sable",
    name: "Sable Financial",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "QUALIFIED",
    email: "ops@sablefinancial.example",
    phone: "+44 20 7946 0107",
    city: "London",
    industry: "Financial services",
    tags: ["sample"],
  },
  {
    key: "tessellate",
    name: "Tessellate Studios",
    partyKind: "ORGANISATION",
    partyType: "CUSTOMER",
    lifecycleStage: "LOST",
    email: "studio@tessellate.example",
    phone: "+44 117 496 0108",
    city: "Bristol",
    industry: "Media",
    tags: ["sample"],
  },
  {
    key: "priya",
    name: "Priya Raman",
    partyKind: "PERSON",
    partyType: "CUSTOMER",
    lifecycleStage: "CUSTOMER",
    email: "priya.raman@northwind.example",
    phone: "+44 7700 900101",
    city: "Manchester",
    industry: "Logistics",
    companyName: "Northwind Logistics",
    jobTitle: "Head of Operations",
    tags: ["sample"],
  },
  {
    key: "tom",
    name: "Tom Whitfield",
    partyKind: "PERSON",
    partyType: "CUSTOMER",
    lifecycleStage: "QUALIFIED",
    email: "t.whitfield@kestrel.example",
    phone: "+44 7700 900102",
    city: "Birmingham",
    industry: "Manufacturing",
    companyName: "Kestrel Manufacturing",
    jobTitle: "Procurement Manager",
    tags: ["sample"],
  },
  {
    key: "aisha",
    name: "Aisha Bello",
    partyKind: "PERSON",
    partyType: "CUSTOMER",
    lifecycleStage: "CONTACTED",
    email: "a.bello@meridianhealth.example",
    phone: "+44 7700 900103",
    city: "Cardiff",
    industry: "Healthcare",
    companyName: "Meridian Health Group",
    jobTitle: "Director of Partnerships",
    tags: ["sample"],
  },
  {
    key: "james",
    name: "James Okonkwo",
    partyKind: "PERSON",
    partyType: "CUSTOMER",
    lifecycleStage: "CUSTOMER",
    email: "james@harbourfinch.example",
    phone: "+44 7700 900104",
    city: "Edinburgh",
    industry: "Professional services",
    companyName: "Harbour & Finch",
    jobTitle: "Managing Partner",
    tags: ["sample"],
  },
];

export const DEALS: readonly DemoDeal[] = [
  {
    key: "northwind-renewal",
    partyKey: "northwind",
    name: "Northwind — annual renewal",
    valueMinor: 4_200_000,
    stage: "NEGOTIATION",
    probability: 70,
    closesInDays: 21,
    nextStep: "Send the renewal quote for countersignature",
  },
  {
    key: "kestrel-rollout",
    partyKey: "kestrel",
    name: "Kestrel — site rollout",
    valueMinor: 12_500_000,
    stage: "PROPOSAL",
    probability: 45,
    closesInDays: 45,
    nextStep: "Walk the operations team through the pilot results",
  },
  {
    key: "meridian-pilot",
    partyKey: "meridian",
    name: "Meridian — pilot programme",
    valueMinor: 2_800_000,
    stage: "QUALIFIED",
    probability: 30,
    closesInDays: 60,
    nextStep: "Confirm the clinical governance requirements",
  },
  {
    key: "sable-expansion",
    partyKey: "sable",
    name: "Sable — seat expansion",
    valueMinor: 1_650_000,
    stage: "LEAD",
    probability: 15,
    closesInDays: 90,
    nextStep: "Find out who owns the budget this year",
  },
  {
    key: "harbour-advisory",
    partyKey: "harbour",
    name: "Harbour & Finch — advisory retainer",
    valueMinor: 6_000_000,
    stage: "WON",
    probability: 100,
    closesInDays: -12,
    nextStep: "Schedule the first quarterly review",
  },
];

export const ACTIVITIES: readonly DemoActivity[] = [
  {
    key: "northwind-call",
    anchor: { deal: "northwind-renewal" },
    kind: "call",
    subject: "Renewal terms",
    body: "Priya wants the same headcount but a shorter term. Agreed to send revised pricing.",
    daysAgo: 2,
  },
  {
    key: "kestrel-meeting",
    anchor: { deal: "kestrel-rollout" },
    kind: "meeting",
    subject: "Pilot review with the operations team",
    body: "Pilot ran clean across two sites. Blocker is the integration with their WMS.",
    daysAgo: 5,
  },
  {
    key: "meridian-email",
    anchor: { deal: "meridian-pilot" },
    kind: "email",
    subject: "Clinical governance questionnaire",
    body: "Sent the completed questionnaire and the data residency note.",
    daysAgo: 8,
  },
  {
    key: "harbour-note",
    anchor: { party: "harbour" },
    kind: "note",
    subject: "Account background",
    body: "Signed after a six-week evaluation. Champion is the managing partner.",
    daysAgo: 14,
  },
  {
    key: "sable-task",
    anchor: { deal: "sable-expansion" },
    kind: "task",
    subject: "Identify the budget holder",
    body: "Ask the operations contact who signs off software this year.",
    daysAgo: 1,
  },
  {
    key: "orchard-email",
    anchor: { party: "orchard" },
    kind: "email",
    subject: "Introduction",
    body: "Replied to the enquiry from the website and offered three times this week.",
    daysAgo: 3,
  },
];
