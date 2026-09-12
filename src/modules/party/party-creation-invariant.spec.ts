import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3, ticket 07 — a party is not created without asking what the plan allows.
 *
 * The ticket was written about autonomous writers, and the audit behind it found
 * something broader: of the four places that insert a `business_parties` row,
 * *three* consulted no limit at all. One of them was the inbound workflow, where
 * a stream of email could create records without bound and nobody had asked for
 * any of them. The other two were the ordinary human and import paths, which had
 * simply never been given the assertion that thirty-seven other write paths in
 * this codebase already carry.
 *
 * A quota that is not enforced is a marketing claim rather than a quota, and the
 * failure is silent: a tenant on a hundred records quietly holds nine thousand,
 * and the first anyone knows is the invoice conversation.
 *
 * So this reads the source. Every `insert(businessParties)` must either consult
 * a plan limit in its own file, or be named below with a reason.
 *
 * The two shapes are both allowed on purpose, because the actor decides which is
 * correct:
 *
 *   - `assertWithinLimit` **throws**, which is right when a person is waiting for
 *     an answer and can be told to upgrade;
 *   - `evaluateAutonomousWrite` **returns a verdict**, which is right when
 *     throwing would unwind an ingest carrying a customer's message — refusing to
 *     record that an email arrived, because a plan limit was reached, loses the
 *     message.
 */

const MODULES = path.join(__dirname, "..");

/** Either enforcement shape, plus the non-throwing lookup the second one needs. */
const CONSULTS_A_LIMIT = /assertWithinLimit|evaluateAutonomousWrite|limitFor\(/;

/**
 * Files that insert a party and legitimately do not check.
 *
 * Listed one by one rather than matched by pattern, so adding one is a
 * deliberate act somebody has to write a sentence about.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "onboarding-activation/seed-demo-dataset.ts",
    // The sample workspace, seeded by us during provisioning rather than by the
    // tenant. Counting it would start a FREE workspace at 12 of its 100 records
    // for rows nobody asked for -- and it is the same reasoning that keeps this
    // data out of the activation signal: ticket 14 defines activation as the
    // workspace holding *the tenant's own* data, so a seeded party is
    // deliberately not the tenant's. Exempt for the same reason
    // `createOrganization` is exempt from the seat check: there is no plan to be
    // over the limit of yet.
    "the demo dataset, seeded during provisioning before the tenant has a plan",
  ],
  [
    "party/party-write-primitives.ts",
    // `insertBareParty` is the seam, not a call site. It moved here from
    // `party-legacy-writer.ts` when that file was split for the 500-line limit,
    // and it is still what `contacts`, `leads`, `clients` and
    // `crm_organizations` all write *through*. Asserting again inside would
    // charge one record against the plan twice and would refuse an import that
    // the caller had already cleared. That every caller asks first is a claim
    // about other files, so the second pair of tests below checks it rather
    // than taking it on trust.
    "the shared seam; every caller asks before reaching it, and that is checked below",
  ],
  [
    "crm/import/writers/party.writer.ts",
    // One of four entity writers behind `writerFor`. The importer asks once for
    // the whole batch, in `claimForCommit`, against the rows still uncommitted --
    // before the commit workflow starts and therefore before any row lands.
    // Asking again per row would charge each record twice, and worse, would
    // refuse halfway and leave the tenant a half-imported file.
    "the importer asserts once per batch in claimForCommit, before any row lands",
  ],
]);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The seam's exemption, checked rather than trusted.
 *
 * `party-write-primitives.ts` is excused because every path into it asks first.
 * That sentence was already written, and it was not true:
 * `CrmOrganizationsService.create` reached the seam without asking anything,
 * and nothing could notice, because the check above only reads files that
 * insert. So a file that calls into the seam is held to the rule a file that
 * inserts is held to.
 */
const SEAM_ENTRY = /\b(?:insertBareParty|createMirrored(?:Leads?|Client|Contacts?|Organization))\s*\(/;

/** The seam itself: these define the entry points above rather than call them. */
const SEAM_FILES: readonly string[] = [
  "party/party-write-primitives.ts",
  "party/party-legacy-writer.ts",
  "party/party-legacy-leads.ts",
  "party/party-legacy-clients.ts",
  "party/party-legacy-contacts.ts",
  "party/party-legacy-orgs.ts",
];

/** Callers of the seam that legitimately do not ask, one sentence each. */
const SEAM_CALLERS_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "leads/lead-conversion.service.ts",
    // Converting a lead creates nothing a plan counts. The lead was charged
    // under `crmLeads` when it was made; the client party the conversion mints
    // sits on `client_party_map`, which neither CRM counter reads (`crmLeads`
    // counts `lead_party_map`, `crmContacts` counts `contact_party_map`), and it
    // is merged onto the lead's own party straight afterwards. Asserting here
    // would refuse to convert a customer the plan already holds.
    "converting a lead mints no party any plan counter reads, and merges it back onto the lead's",
  ],
]);

describe("every path that creates a party asks what the plan allows", () => {
  it("finds no insert that skips the question", () => {
    const unguarded: string[] = [];

    for (const file of walk(MODULES)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("insert(businessParties)")) continue;

      const relative = path.relative(MODULES, file).split(path.sep).join("/");
      if (EXEMPT.has(relative)) continue;
      if (CONSULTS_A_LIMIT.test(source)) continue;

      unguarded.push(relative);
    }

    // Named rather than counted, so a failure says which file to look at.
    expect(unguarded).toEqual([]);
  });

  /**
   * The other direction, so the exemption list cannot rot.
   *
   * An entry that no longer inserts a party is an entry that stopped meaning
   * anything and would quietly excuse the next thing added to that file.
   */
  it("keeps no exemption for a file that no longer creates a party", () => {
    const stale = [...EXEMPT.keys()].filter((relative) => {
      const full = path.join(MODULES, relative);
      if (!fs.existsSync(full)) return true;
      return !fs.readFileSync(full, "utf8").includes("insert(businessParties)");
    });

    expect(stale).toEqual([]);
  });

  it("finds no caller of the seam that skips the question", () => {
    const unasked: string[] = [];

    for (const file of walk(MODULES)) {
      const relative = path.relative(MODULES, file).split(path.sep).join("/");
      if (SEAM_FILES.includes(relative) || SEAM_CALLERS_EXEMPT.has(relative)) continue;

      const source = fs.readFileSync(file, "utf8");
      if (!SEAM_ENTRY.test(source)) continue;
      if (CONSULTS_A_LIMIT.test(source)) continue;

      unasked.push(relative);
    }

    expect(unasked).toEqual([]);
  });

  it("keeps no seam file or seam-caller exemption that no longer means anything", () => {
    const missingSeam = SEAM_FILES.filter((relative) => !fs.existsSync(path.join(MODULES, relative)));
    const stale = [...SEAM_CALLERS_EXEMPT.keys()].filter((relative) => {
      const full = path.join(MODULES, relative);
      return !fs.existsSync(full) || !SEAM_ENTRY.test(fs.readFileSync(full, "utf8"));
    });

    expect([...missingSeam, ...stale]).toEqual([]);
  });
});
