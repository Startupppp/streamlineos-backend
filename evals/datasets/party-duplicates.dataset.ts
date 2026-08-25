import type { PartyFingerprint } from "../../src/modules/party/party-duplicates";

/**
 * Labelled pairs for measuring duplicate detection.
 *
 * `same` is the ground truth: whether a human would say these two rows describe
 * one organisation. The hard cases are deliberately over-represented — pairs
 * that look identical and are not, and pairs that look unrelated and are — since
 * those are the ones a weighting gets wrong.
 */
export interface DuplicateCase {
  readonly name: string;
  readonly left: PartyFingerprint;
  readonly right: PartyFingerprint;
  readonly same: boolean;
  /** True where a human would expect no confirmation to be asked for. */
  readonly obvious?: boolean;
}

const p = (id: string, fields: Omit<PartyFingerprint, "partyId">): PartyFingerprint => ({
  partyId: id,
  ...fields,
});

export const PARTY_DUPLICATE_DATASET: readonly DuplicateCase[] = [
  {
    name: "same company, legal suffix differs",
    left: p("a", { name: "Acme Trading", taxNumber: "GB123456789" }),
    right: p("b", { name: "Acme Trading Ltd", taxNumber: "GB 123 456 789" }),
    same: true,
    obvious: true,
  },
  {
    name: "same company, one record entered from an email signature",
    left: p("a", { name: "Northwind Logistics", email: "accounts@northwind.example" }),
    right: p("b", { name: "Northwind Logistics Pvt Ltd", email: "Accounts@Northwind.Example" }),
    same: true,
    obvious: true,
  },
  {
    name: "same company, phone written with and without a country code",
    left: p("a", { name: "Bluepeak Foods", phone: "+44 20 7946 0123", website: "bluepeak.example" }),
    right: p("b", { name: "Bluepeak Foods Limited", phone: "020 7946 0123", website: "https://www.bluepeak.example" }),
    same: true,
    obvious: true,
  },
  {
    name: "same company, name misspelt on one record",
    left: p("a", { name: "Meridian Steelworks", taxNumber: "IN29ABCDE1234F1Z5" }),
    right: p("b", { name: "Meridien Steelworks", taxNumber: "IN29ABCDE1234F1Z5" }),
    same: true,
    obvious: true,
  },
  {
    name: "same company, trading name against registered name",
    left: p("a", { name: "Kestrel", legalName: "Kestrel Holdings", email: "hello@kestrel.example" }),
    right: p("b", { name: "Kestrel Holdings Ltd", email: "hello@kestrel.example" }),
    same: true,
    obvious: true,
  },
  {
    name: "same company, only a shared site and name",
    left: p("a", { name: "Harbourline Marine", website: "harbourline.example" }),
    right: p("b", { name: "Harbourline Marine Co", website: "www.harbourline.example/contact" }),
    same: true,
  },

  {
    name: "two branches of a group, different registrations",
    left: p("a", { name: "Vertex Retail", taxNumber: "GB111111111", email: "ops@vertex.example" }),
    right: p("b", { name: "Vertex Retail", taxNumber: "GB222222222", email: "ops@vertex.example" }),
    same: false,
  },
  {
    name: "unrelated companies sharing a common name",
    left: p("a", { name: "Summit Consulting", email: "info@summit-uk.example", phone: "+44 20 1111 2222" }),
    right: p("b", { name: "Summit Consulting", email: "contact@summitindia.example", phone: "+91 98111 22222" }),
    same: false,
  },
  {
    name: "two people at one company, entered as parties",
    left: p("a", { name: "Orion Labs (Priya)", email: "priya@orionlabs.example" }),
    right: p("b", { name: "Orion Labs (Sam)", email: "sam@orionlabs.example" }),
    same: false,
  },
  {
    name: "a customer and its unrelated supplier",
    left: p("a", { name: "Cedar Fabrications", email: "ap@cedarfab.example" }),
    right: p("b", { name: "Cedarwood Interiors", email: "hello@cedarwood.example" }),
    same: false,
  },
  {
    name: "sparse records with nothing but different names",
    left: p("a", { name: "Ashgrove" }),
    right: p("b", { name: "Fernhill" }),
    same: false,
  },
  {
    name: "same name, one is a dormant subsidiary with its own number",
    left: p("a", { name: "Lattice Systems", taxNumber: "GB555000111", phone: "+44 161 555 0100" }),
    right: p("b", { name: "Lattice Systems", taxNumber: "GB555000222", phone: "+44 161 555 0100" }),
    same: false,
  },
  {
    name: "franchisees sharing a brand and a switchboard",
    left: p("a", { name: "Brightwash Leeds", website: "brightwash.example", email: "leeds@brightwash.example" }),
    right: p("b", { name: "Brightwash York", website: "brightwash.example", email: "york@brightwash.example" }),
    same: false,
  },
];
