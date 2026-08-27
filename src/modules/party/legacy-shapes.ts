/**
 * The four legacy record shapes, written out so the tables can go.
 *
 * Phase 2, ticket 08 — the contract. `LeadRow` and its siblings were
 * `typeof leads.$inferSelect`: derived from a table definition, which meant the
 * definition could not be deleted while anything spoke that vocabulary. Two
 * dozen files do.
 *
 * They speak it for a good reason. The modules stopped *reading* those tables
 * long ago — `leadViewFrom` builds a whole lead out of a Party row through
 * `LEAD_MIRROR.derive`, and every writer now assembles its return value the same
 * way. The legacy shape is the vocabulary the CRM has always used to talk about
 * a lead. **The shape is worth keeping; the table it was inferred from is not.**
 *
 * So these are written out rather than inferred. Generated from the live
 * catalogue rather than typed by hand, and `legacy-shapes.spec.ts` asserts each
 * one is structurally identical to what `$inferSelect` produced — which is what
 * makes deleting the table a no-op for every consumer rather than a leap.
 *
 * Nullability follows the column. `*Insert` makes a column optional when the
 * database has a default for it, which is exactly what Drizzle inferred.
 *
 * **Not `readonly`**, deliberately, and this cost a compile to learn:
 * `$inferSelect` produces mutable properties, several callers assign to the row
 * they were handed, and the structural equality check in `legacy-shapes.spec.ts`
 * cannot see the difference — TypeScript's assignability ignores `readonly` on
 * object types, so stricter-than-inferred passed the assertion and failed at
 * eight call sites. The proof covers names, types and nullability; mutability it
 * cannot speak about.
 *
 * Type aliases rather than interfaces, and that is load-bearing too: an
 * interface has no implicit index signature, so it does not satisfy
 * `Record<string, unknown>` — which `ErasedRow` is, and which the divergence
 * machinery passes these rows as. Drizzle's inferred mapped types do satisfy it.
 */

export type LegacyLeadRow = {
  id: number;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  source: string;
  campaignId: number | null;
  status: string;
  priority: string;
  investmentInterest: string | null;
  potentialValue: string | null;
  notes: string | null;
  assignedToId: string | null;
  assignedById: string | null;
  verifiedById: string | null;
  assignedAt: Date | null;
  convertedAt: Date | null;
  lostReason: string | null;
  company: string | null;
  designation: string | null;
  city: string | null;
  referredBy: string | null;
  tags: string[] | null;
  score: number;
  slaDeadline: Date | null;
  website: string | null;
  subSource: string | null;
  dmLeadId: number | null;
  followUpDate: Date | null;
  followUpNotes: string | null;
  customData: Record<string, unknown> | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  ipAddress: string | null;
  referrerUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  mergedIntoId: number | null;
};

export type LegacyLeadInsert = {
  id?: number;
  orgId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  whatsappNumber?: string | null;
  source?: string;
  campaignId?: number | null;
  status?: string;
  priority?: string;
  investmentInterest?: string | null;
  potentialValue?: string | null;
  notes?: string | null;
  assignedToId?: string | null;
  assignedById?: string | null;
  verifiedById?: string | null;
  assignedAt?: Date | null;
  convertedAt?: Date | null;
  lostReason?: string | null;
  company?: string | null;
  designation?: string | null;
  city?: string | null;
  referredBy?: string | null;
  tags?: string[] | null;
  score?: number;
  slaDeadline?: Date | null;
  website?: string | null;
  subSource?: string | null;
  dmLeadId?: number | null;
  followUpDate?: Date | null;
  followUpNotes?: string | null;
  customData?: Record<string, unknown> | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  ipAddress?: string | null;
  referrerUrl?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
  mergedIntoId?: number | null;
};

export type LegacyClientRow = {
  id: number;
  orgId: string;
  leadId: number | null;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  designation: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  isVendor: boolean;
  investmentValue: string | null;
  status: string;
  accountManagerId: string | null;
  notes: string | null;
  healthScore: number;
  healthStatus: "healthy" | "at_risk" | "critical";
  lastHealthCheck: Date | null;
  churnRiskScore: number | null;
  churnRiskReasoning: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LegacyClientInsert = {
  id?: number;
  orgId: string;
  leadId?: number | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  designation?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  isVendor?: boolean;
  investmentValue?: string | null;
  status?: string;
  accountManagerId?: string | null;
  notes?: string | null;
  healthScore?: number;
  healthStatus?: "healthy" | "at_risk" | "critical";
  lastHealthCheck?: Date | null;
  churnRiskScore?: number | null;
  churnRiskReasoning?: string | null;
  convertedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type LegacyContactRow = {
  id: number;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  department: string | null;
  company: string | null;
  organizationId: number | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  avatarUrl: string | null;
  leadId: number | null;
  dealId: number | null;
  tags: string[];
  deletedAt: Date | null;
  mergedIntoId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LegacyContactInsert = {
  id?: number;
  orgId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  department?: string | null;
  company?: string | null;
  organizationId?: number | null;
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  avatarUrl?: string | null;
  leadId?: number | null;
  dealId?: number | null;
  tags?: string[];
  deletedAt?: Date | null;
  mergedIntoId?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type LegacyCrmOrgRow = {
  id: number;
  orgId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: "1-10" | "11-50" | "51-200" | "201-1000" | "1000+" | null;
  website: string | null;
  linkedinUrl: string | null;
  description: string | null;
  healthScore: number | null;
  parentId: number | null;
  notes: string | null;
  deletedAt: Date | null;
  mergedIntoId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LegacyCrmOrgInsert = {
  id?: number;
  orgId: string;
  name: string;
  domain?: string | null;
  industry?: string | null;
  size?: "1-10" | "11-50" | "51-200" | "201-1000" | "1000+" | null;
  website?: string | null;
  linkedinUrl?: string | null;
  description?: string | null;
  healthScore?: number | null;
  parentId?: number | null;
  notes?: string | null;
  deletedAt?: Date | null;
  mergedIntoId?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * The same columns again, as values.
 *
 * `party-legacy-mirror.spec.ts` asserts that every legacy column is either
 * mirrored from Party or declared legacy-owned, with no column in both and none
 * in neither. That check needs the column list at *runtime*, and it used to get
 * it from `getTableColumns(leads)` — which is exactly the dependency ticket 08
 * removes. A type cannot be enumerated at runtime, so the list has to exist
 * twice.
 *
 * Listing it twice is only safe if the two cannot drift, so `columnsOf` makes
 * drift a compile error in both directions: a column named here that the type
 * does not have is rejected by `keyof`, and a column the type has that is
 * missing here makes the helper's second parameter unsatisfiable, so `tsc`
 * names the absent column back at you. Adding a column to a shape above without
 * adding it here does not build.
 *
 * This is the same job `legacy-shapes.spec.ts` did for the shapes themselves,
 * done in the one direction that outlives the tables. That spec compared these
 * types to `$inferSelect` and could only ever run while the tables existed; it
 * ran, it passed, and it went with them.
 */
type Complete<T, K extends readonly (keyof T)[]> = [Exclude<keyof T, K[number]>] extends [never]
  ? K
  : { __missing: Exclude<keyof T, K[number]> };

const columnsOf =
  <T,>() =>
  <K extends readonly (keyof T)[]>(...columns: K & Complete<T, K>): readonly string[] =>
    columns as readonly string[];

const LEAD_COLUMNS = columnsOf<LegacyLeadRow>()(
  "id",
  "orgId",
  "name",
  "email",
  "phone",
  "whatsappNumber",
  "source",
  "campaignId",
  "status",
  "priority",
  "investmentInterest",
  "potentialValue",
  "notes",
  "assignedToId",
  "assignedById",
  "verifiedById",
  "assignedAt",
  "convertedAt",
  "lostReason",
  "company",
  "designation",
  "city",
  "referredBy",
  "tags",
  "score",
  "slaDeadline",
  "website",
  "subSource",
  "dmLeadId",
  "followUpDate",
  "followUpNotes",
  "customData",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "ipAddress",
  "referrerUrl",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "mergedIntoId",
);

const CLIENT_COLUMNS = columnsOf<LegacyClientRow>()(
  "id",
  "orgId",
  "leadId",
  "name",
  "email",
  "phone",
  "company",
  "designation",
  "city",
  "state",
  "gstin",
  "isVendor",
  "investmentValue",
  "status",
  "accountManagerId",
  "notes",
  "healthScore",
  "healthStatus",
  "lastHealthCheck",
  "churnRiskScore",
  "churnRiskReasoning",
  "convertedAt",
  "createdAt",
  "updatedAt",
);

const CONTACT_COLUMNS = columnsOf<LegacyContactRow>()(
  "id",
  "orgId",
  "name",
  "email",
  "phone",
  "title",
  "department",
  "company",
  "organizationId",
  "linkedinUrl",
  "twitterUrl",
  "websiteUrl",
  "avatarUrl",
  "leadId",
  "dealId",
  "tags",
  "deletedAt",
  "mergedIntoId",
  "createdAt",
  "updatedAt",
);

const ORGANISATION_COLUMNS = columnsOf<LegacyCrmOrgRow>()(
  "id",
  "orgId",
  "name",
  "domain",
  "industry",
  "size",
  "website",
  "linkedinUrl",
  "description",
  "healthScore",
  "parentId",
  "notes",
  "deletedAt",
  "mergedIntoId",
  "createdAt",
  "updatedAt",
);


export const LEGACY_COLUMNS: Record<
  "LEAD" | "CLIENT" | "CONTACT" | "ORGANISATION",
  readonly string[]
> = {
  LEAD: LEAD_COLUMNS,
  CLIENT: CLIENT_COLUMNS,
  CONTACT: CONTACT_COLUMNS,
  ORGANISATION: ORGANISATION_COLUMNS,
};
