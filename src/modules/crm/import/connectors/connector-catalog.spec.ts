import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMN_MAPPING_DATASET } from "../../../../../evals/datasets/column-mapping.dataset";
import { mapColumns } from "../column-mapping";
import { planImport } from "../import-plan";
import { CONNECTORS, connectorFor, streamFor } from "./connector-catalog";
import { watermarkAfterWalk } from "./connector-watermark";
import {
  ConnectorShapeError,
  CONNECTOR_PROVIDERS,
  CONNECTOR_STREAMS,
  newestModifiedAt,
  toIntermediate,
  type ConnectorProvider,
} from "./connector-source";

/**
 * The connectors, driven from fixtures.
 *
 * No provider SDK is mocked anywhere in this file, and none is imported. The
 * fixtures below are response bodies in the shape each provider's REST API
 * documents, and every parser is a pure function of one of them — so the fixture
 * IS the contract, and a provider changing its payload shows up as one of these
 * going red rather than as a channel that quietly reads nothing.
 *
 * What that cannot check is whether the PATHS are right, because nothing in this
 * repository has ever called any of these four. That is a deliberate, bounded
 * risk: every request goes through `ComposioGateway.executeProxy`, which throws
 * on any status at or above 400, so a wrong path is a 404 on the first attempt
 * rather than a silent empty read. The alternative — a named Composio tool slug
 * — fails the other way, and a channel that ingests nothing for weeks is the
 * failure this whole design is arranged around.
 */

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));
}

/** The one stream of each provider that has a destination today. */
const ACCOUNTS_FIXTURES: Readonly<Record<ConnectorProvider, [string, string]>> = {
  salesforce: ["salesforce-accounts.page1", "salesforce-accounts.page2"],
  hubspot: ["hubspot-companies.page1", "hubspot-companies.page2"],
  zoho: ["zoho-accounts.page1", "zoho-accounts.page2"],
  pipedrive: ["pipedrive-organizations.page1", "pipedrive-organizations.page2"],
};

describe("the connector catalog", () => {
  it("has a descriptor for every provider and every stream", () => {
    for (const provider of CONNECTOR_PROVIDERS) {
      const descriptor = connectorFor(provider);
      expect(descriptor.provider).toBe(provider);

      for (const stream of CONNECTOR_STREAMS) {
        const declared = streamFor(provider, stream);
        expect(declared.fields.length).toBeGreaterThan(3);
        expect(declared.firstRequest(null).path.startsWith("/")).toBe(true);
      }
    }
  });

  /**
   * Only what can actually be landed is marked writable.
   *
   * `party` has an importer — a plan, a preview, a durable commit and an undo.
   * The other three targets have none, and a connector that read them would
   * write nothing while looking exactly like one that worked.
   */
  it("marks a stream writable only where its target has an importer", () => {
    for (const provider of CONNECTOR_PROVIDERS)
      for (const stream of CONNECTOR_STREAMS) {
        const declared = streamFor(provider, stream);
        expect(declared.writable).toBe(declared.target === "party");
      }

    // All four targets are declared, so the refusal can name the right one.
    const targets = new Set(
      CONNECTOR_STREAMS.map((stream) => streamFor("salesforce", stream).target),
    );
    expect([...targets].sort()).toEqual(["activity", "party", "pipeline-stage", "subject"]);
  });

  /**
   * The headers a connector emits are headers the mapping evals measure.
   *
   * This is what makes the API path and the paste path one system rather than
   * two that resemble each other. A connector that started emitting a header the
   * dataset has never seen would be a mapping nobody has measured, and this goes
   * red the moment that happens.
   *
   * Matched on the header string alone, across products, because the mapper sees
   * nothing else: a spelling covered once is covered.
   */
  it("emits only headers the mapping dataset covers", () => {
    const covered = new Set(COLUMN_MAPPING_DATASET.map((c) => c.header));

    const uncovered = CONNECTOR_PROVIDERS.flatMap((provider) =>
      streamFor(provider, "accounts")
        .fields.filter((field) => !covered.has(field.header))
        .map((field) => `${provider}: ${field.header}`),
    );

    expect(uncovered).toEqual([]);
  });
});

describe.each(CONNECTOR_PROVIDERS)("%s accounts", (provider) => {
  const [firstName, lastName] = ACCOUNTS_FIXTURES[provider];
  const stream = streamFor(provider, "accounts");

  it("reads its own payload into records with an id and a modification time", () => {
    const page = stream.parsePage(fixture(firstName));

    expect(page.records.length).toBeGreaterThan(0);
    for (const record of page.records) {
      expect(record.sourceId).not.toBe("");
      // Without this the watermark has nothing to advance to, which is the one
      // thing that must never be guessed.
      expect(record.modifiedAt).toBeInstanceOf(Date);
    }
  });

  /**
   * Paging follows the provider, and stops when the provider says so.
   *
   * The second page of every fixture is the last one, and the parser has to
   * recognise that from a different signal in each of the four: Salesforce drops
   * `nextRecordsUrl`, HubSpot drops `paging`, Zoho sets `more_records: false`,
   * Pipedrive sets `more_items_in_collection: false`.
   */
  it("follows the provider's own next page and recognises the end", () => {
    const first = stream.parsePage(fixture(firstName));
    expect(first.next).not.toBeNull();
    expect(first.next?.path.startsWith("/")).toBe(true);

    const last = stream.parsePage(fixture(lastName));
    expect(last.next).toBeNull();
  });

  it("refuses a payload it does not recognise instead of reading nothing", () => {
    for (const payload of [null, {}, { error: "invalid_grant" }, [1, 2, 3], "nope"])
      expect(() => stream.parsePage(payload)).toThrow(ConnectorShapeError);
  });

  /**
   * The intermediate is a header row and cell rows, and every row has a cell for
   * every header — including the ones the provider said nothing about.
   */
  it("produces a rectangular intermediate", () => {
    const page = stream.parsePage(fixture(firstName));
    const { headers, rows } = toIntermediate(stream.fields, page.records);

    expect(headers).toEqual(stream.fields.map((field) => field.header));
    expect(rows).toHaveLength(page.records.length);
    for (const row of rows) expect(row).toHaveLength(headers.length);
  });

  /**
   * The whole point, end to end: what the connector produces goes through the
   * paste path's own mapper and planner and comes out as a party.
   *
   * Nothing connector-specific runs below this line — `mapColumns` and
   * `planImport` are the functions a pasted CSV goes through, called with the
   * connector's headers and rows exactly as the controller would call them with
   * a person's.
   */
  it("plans as parties through the universal path", () => {
    const page = stream.parsePage(fixture(firstName));
    const { headers, rows } = toIntermediate(stream.fields, page.records);

    const plan = planImport({ columns: mapColumns(headers), rows, existing: [] });

    expect(plan.summary.total).toBe(rows.length);
    expect(plan.summary.create).toBe(rows.length);
    expect(plan.summary.skip).toBe(0);

    for (const row of plan.rows) expect(row.values.name).toBeTruthy();
  });

  /**
   * And the identity guard holds on the connector's own headers.
   *
   * Every one of these four exports the record's owner, and a rep owns hundreds
   * of accounts. If the owner's name reached `name`, or an owner e-mail reached
   * `email`, every account that rep owns would score as one party.
   */
  it("keeps the owner column out of the identity fields", () => {
    const columns = mapColumns(stream.fields.map((field) => field.header));
    const ownerHeaders = stream.fields
      .map((field) => field.header)
      .filter((header) => /owner/i.test(header));

    expect(ownerHeaders.length).toBeGreaterThan(0);

    for (const header of ownerHeaders) {
      const column = columns.find((c) => c.header === header);
      expect(column?.mapping.kind).toBe("custom");
    }
  });
});

describe("the watermark", () => {
  const older = new Date("2026-08-01T00:00:00Z");
  const newer = new Date("2026-08-20T00:00:00Z");

  /**
   * The rule the whole ticket turns on, and the one the mailbox sweep learned
   * the hard way. A partial walk of an unordered collection says nothing about
   * any time range, so it may claim nothing.
   */
  it("advances nothing when the walk did not reach the end", () => {
    expect(watermarkAfterWalk(null, newer, false)).toBeNull();
    expect(watermarkAfterWalk(older, newer, false)).toBe(older);
  });

  it("advances to the newest record actually staged, once the walk drained", () => {
    expect(watermarkAfterWalk(null, newer, true)).toBe(newer);
    expect(watermarkAfterWalk(older, newer, true)).toBe(newer);
  });

  it("never moves backwards, and never moves on nothing", () => {
    expect(watermarkAfterWalk(newer, older, true)).toBe(newer);
    expect(watermarkAfterWalk(newer, null, true)).toBe(newer);
    expect(watermarkAfterWalk(null, null, true)).toBeNull();
  });

  /**
   * A record whose modification time the provider did not give us contributes
   * nothing, so it can never push the line past itself.
   */
  it("ignores records with no modification time", () => {
    const records = [
      { sourceId: "a", modifiedAt: null, values: {} },
      { sourceId: "b", modifiedAt: older, values: {} },
      { sourceId: "c", modifiedAt: null, values: {} },
    ];
    expect(newestModifiedAt(records)).toBe(older);
    expect(newestModifiedAt([{ sourceId: "a", modifiedAt: null, values: {} }])).toBeNull();
  });
});

describe("what a walk asks for", () => {
  /**
   * Only Salesforce can express the floor in the request. The other three would
   * need an argument name this repository has no call site to check against, and
   * a query parameter a provider does not recognise is ignored rather than
   * rejected — which returns a plausible page covering the wrong window.
   */
  it("uses the watermark only where the provider documents a filter", () => {
    const since = new Date("2026-08-01T00:00:00Z");

    const salesforce = streamFor("salesforce", "accounts");
    expect(salesforce.firstRequest(since).path).not.toEqual(
      salesforce.firstRequest(null).path,
    );
    expect(decodeURIComponent(salesforce.firstRequest(since).path)).toContain(
      "LastModifiedDate > 2026-08-01",
    );

    for (const provider of ["hubspot", "zoho", "pipedrive"] as const) {
      const stream = streamFor(provider, "accounts");
      expect(stream.firstRequest(since).path).toEqual(stream.firstRequest(null).path);
    }
  });

  /**
   * A path, never a URL: Composio's proxy resolves the base from the connected
   * account, so an absolute URL is not a request this repository can make. That
   * is why HubSpot's `paging.next.link` is ignored in favour of its `after`.
   */
  it("only ever produces paths", () => {
    const requests = CONNECTOR_PROVIDERS.flatMap((provider) =>
      CONNECTOR_STREAMS.map((stream) => streamFor(provider, stream).firstRequest(null)),
    );

    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.path).toMatch(/^\//);
      expect(request.path).not.toMatch(/^https?:/);
    }

    const hubspot = streamFor("hubspot", "accounts");
    const next = hubspot.parsePage(fixture("hubspot-companies.page1")).next;
    expect(next?.path).toMatch(/^\/crm\/v3\/objects\/companies\?/);
    expect(next?.path).toContain("after=");
  });

  it("declares one connector per provider, exhaustively", () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual([...CONNECTOR_PROVIDERS].sort());
  });
});
