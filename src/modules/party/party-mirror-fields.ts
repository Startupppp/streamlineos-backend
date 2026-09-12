import type { MappedLegacyKind } from "./party-legacy-seam";
import { PARTY_FIELD_MIRROR_CORE_ENTRIES } from "./party-mirror-fields-core-entries";
import { PARTY_FIELD_MIRROR_LEAD_ENTRIES } from "./party-mirror-fields-lead-entries";
import {
  type ClientInsert,
  type ContactInsert,
  type CrmOrgInsert,
  type ErasedRow,
  type LeadInsert,
  type MirrorCell,
  type PartyFieldMirror,
  type PartyPatch,
  type PartyRow,
} from "./party-mirror-fields-types";

export type {
  ClientInsert,
  ContactInsert,
  CrmOrgInsert,
  ErasedRow,
  LeadInsert,
  MirrorCell,
  PartyFieldMirror,
  PartyPatch,
  PartyRow,
};

export const PARTY_FIELD_MIRROR: Record<keyof PartyRow, PartyFieldMirror> = {
  ...PARTY_FIELD_MIRROR_CORE_ENTRIES,
  ...PARTY_FIELD_MIRROR_LEAD_ENTRIES,
};

/**
 * Only columns a legacy shape actually has. The `*_membership_id` companions
 * 0817 declared on `leads` and `clients` are not here: 0278 dropped those tables,
 * c464007c7 took them out of the code, and the shapes in `legacy-shapes.ts` --
 * the contract that outlived them -- do not carry the companions. An entry for a
 * column no legacy row has would excuse a field nothing derives, reads or writes.
 */
export const LEGACY_OWNED_COLUMNS: Record<MappedLegacyKind, Readonly<Record<string, string>>> = {
  LEAD: {
    id: "The legacy identity itself; `lead_party_map` is how it reaches a Party.",
    dmLeadId: "An id in the upstream DM system. Party has no home for another system's key.",
    mergedIntoId:
      "The legacy merge pointer. `party_merges` is the Party mechanism, and re-pointing the map row is how a merge reaches this table.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  CLIENT: {
    id: "The legacy identity itself.",
    leadId:
      "Which lead this client converted from, which Party now owns as `converted_from_party_id`. Listed here because the two speak different id spaces -- an integer `leads` id against a party id -- so the column is maintained by `party-legacy-associations.ts` through `lead_party_map` rather than by a pure cell above. Legacy-owned in shape only; nothing outside the writer sets it.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  CONTACT: {
    id: "The legacy identity itself.",
    organizationId:
      "The employer, which Party now owns as `employer_party_id`. Listed here because the two speak different id spaces -- an integer `crm_organizations` id against a party id -- so the column is maintained by `party-legacy-employer.ts` through `crm_org_party_map` rather than by a pure cell above. Legacy-owned in shape only; nothing outside the writer sets it.",
    leadId:
      "Which lead this contact was raised against -- the same relation `clients.lead_id` names, and the same Party column, `converted_from_party_id`. Maintained by `party-legacy-associations.ts` for the reason recorded on `clients.leadId`. Legacy-owned in shape only; nothing outside the writer sets it.",
    mergedIntoId: "The legacy merge pointer; see `leads.mergedIntoId`.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  ORGANISATION: {
    id: "The legacy identity itself; `crm_org_party_map` is how it reaches a Party.",
    parentId:
      "The account hierarchy -- which company owns which. Party owns it as `parent_party_id` from 0265: a party-to-party link like `employer_party_id`, and deliberately not folded into it, because a subsidiary's parent is not its employer and one column serving both would make the name a lie. Ticket 25 converged the identity and left the hierarchy; the contract step could not drop the table while the hierarchy reads still joined it. Maintained by `party-legacy-associations.ts` through `crm_org_party_map`; legacy-owned in shape only.",
    mergedIntoId: "The legacy merge pointer; see `leads.mergedIntoId`.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
};
