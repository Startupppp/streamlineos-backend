import { ContactsService } from "./contacts.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { createMirroredContacts } from "../party/party-legacy-contacts";

/**
 * The import no longer issues one multi-row INSERT.
 *
 * Party is canonical from Phase 2 ticket 02, so each contact is now a party row
 * written first and a `contacts` row derived from it, and a chunk is a loop
 * inside one transaction rather than a single statement. The property the import
 * actually depends on is unchanged and still asserted below: a chunk lands
 * whole or not at all, and a rejected chunk bisects until only the bad row
 * fails. What changed is the statement count, which is the cost of the mirror
 * and is recorded here rather than hidden.
 */
jest.mock("../party/party-legacy-contacts", () => ({
  createMirroredContact: jest.fn(),
  createMirroredContacts: jest.fn(),
  softDeleteMirroredContacts: jest.fn(),
  updateMirroredContact: jest.fn(),
}));

const mirrorCreate = createMirroredContacts as unknown as jest.Mock;

/**
 * A Drizzle chain that carries the joins the contact reads now issue.
 *
 * `lookups` feeds the map reads a contact page makes after its own query.
 * `lead_party_map` and `crm_org_party_map` are keyed by their legacy id rather
 * than by `party_id`, so the two association ids cannot be joined in without
 * risking a duplicated row and are resolved per page instead — which is two more
 * awaited statements the chain has to be able to answer. The chain is thenable
 * for exactly that: the projection reads end in `.limit()`, the map reads end in
 * `.where()`.
 */
function makeSelectChain(rows: unknown[], lookups: unknown[][] = []) {
  const queue = [...lookups];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
  };
  for (const key of ["from", "innerJoin", "leftJoin", "where", "orderBy", "offset"])
    chain[key]!.mockReturnValue(chain);
  chain.limit!.mockResolvedValue(rows);
  (chain as unknown as PromiseLike<unknown>).then = ((resolve: (value: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve)) as never;
  return { chain, db: { select: jest.fn().mockReturnValue(chain) } };
}

describe("ContactsService bulk import", () => {
  /**
   * The relational read is gone, and with it the `with: { columns: … }` this
   * used to assert on. The property it was guarding is not: a contact's lead,
   * deal and employer are exposed as an id and a name and nothing else. It is
   * asserted on the result now, which is the thing a caller actually receives —
   * and which no longer depends on Drizzle's relational API being asked nicely.
   */
  it("projects only public identity fields from contact relations", async () => {
    const chain = makeSelectChain(
      [
        {
          id: 42,
          orgId: "org-1",
          name: "Ada",
          // The associations are the party's own links now; the integer ids the
          // response carries come back off the maps below.
          leadPartyId: "party-lead",
          employerPartyId: "party-acme",
          dealId: 9,
          leadName: "Ada (lead)",
          dealName: "Renewal",
          crmOrganizationName: "ACME",
        },
      ],
      [
        [{ partyId: "party-lead", leadId: 3 }],
        [{ partyId: "party-acme", crmOrganizationId: 7 }],
      ],
    );
    const service = new ContactsService(chain.db as never, {} as never, {} as never);

    const contact = await service.getContact("org-1", 42);

    expect(contact).toBeDefined();
    expect(Object.keys(contact!.lead!)).toEqual(["id", "name"]);
    expect(Object.keys(contact!.deal!)).toEqual(["id", "name"]);
    expect(Object.keys(contact!.crmOrganization!)).toEqual(["id", "name"]);
    // The joined-table columns are folded into those objects, never left loose
    // on the contact itself.
    expect(contact).not.toHaveProperty("leadName");
    expect(contact).not.toHaveProperty("dealName");
    expect(contact).not.toHaveProperty("crmOrganizationName");
    // And the party ids they were resolved from stay inside the seam: a caller
    // still receives the legacy integers every URL and DTO is written against.
    expect(contact).not.toHaveProperty("leadPartyId");
    expect(contact).not.toHaveProperty("employerPartyId");
    expect(contact!.lead).toEqual({ id: 3, name: "Ada (lead)" });
    expect(contact!.crmOrganization).toEqual({ id: 7, name: "ACME" });
  });

  it("streams export rows in bounded keyset pages with one CSV header", async () => {
    const makeRow = (id: number) => ({
      id,
      name: id === 1 ? "=unsafe" : `Contact ${id}`,
      email: null,
      phone: null,
      title: null,
      company: null,
      department: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const limit = jest
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, index) => makeRow(index + 1)))
      .mockResolvedValueOnce([makeRow(501)]);
    const query = {
      from: jest.fn(),
      // The export reads `business_parties` through `contact_party_map`.
      innerJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit,
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    const service = new ContactsService(
      { select: jest.fn().mockReturnValue(query) } as never,
      {} as never,
      {} as never,
    );

    const chunks: string[] = [];
    for await (const chunk of service.exportCsvChunks("org-1")) chunks.push(chunk);
    const csv = chunks.join("");

    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenCalledWith(500);
    expect(csv.match(/^id,name,email,phone,title,company,department,createdAt$/gm)).toHaveLength(1);
    expect(csv.split("\n")).toHaveLength(502);
    expect(csv).toContain("1,'=unsafe");
    expect(csv).toContain("501,Contact 501");
  });

  it("reads contact pages through the organization namespace", async () => {
    const cachedVersioned = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const service = new ContactsService(
      {} as never,
      { cachedVersioned } as never,
      {} as never,
    );

    await service.list("org-1", { limit: 25, offset: 0 });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.contactsListNamespace("org-1"),
      expect.any(String),
      expect.any(Function),
      expect.any(Number),
    );
  });

  it("writes a valid import as one mirrored chunk", async () => {
    mirrorCreate.mockReset().mockResolvedValue([]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const limits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactsService({} as never, cache as never, limits as never);

    await expect(
      service.bulkImport("org-1", {
        contacts: [
          { name: "Ada", email: "ada@example.com" },
          { name: "Grace", email: "grace@example.com" },
        ],
      }),
    ).resolves.toEqual({ created: 2, failed: 0 });

    expect(mirrorCreate).toHaveBeenCalledTimes(1);
    expect(mirrorCreate).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.arrayContaining([expect.objectContaining({ orgId: "org-1", name: "Ada" })]),
      { linkedBy: "contacts:import" },
    );
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.contactsListNamespace("org-1"),
    );
  });

  it("bisects a rejected batch and retains partial-success counts", async () => {
    const inserted: string[] = [];
    mirrorCreate
      .mockReset()
      .mockImplementation(async (_db: unknown, _orgId: string, rows: Array<{ name: string }>) => {
        // A chunk is still all-or-nothing: the transaction the writer opens rolls
        // back every party and every mirror row in it.
        if (rows.some((row) => row.name === "Invalid")) throw new Error("constraint");
        inserted.push(...rows.map((row) => row.name));
        return [];
      });
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const limits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactsService({} as never, cache as never, limits as never);

    await expect(
      service.bulkImport("org-1", {
        contacts: [{ name: "Ada" }, { name: "Invalid" }, { name: "Grace" }],
      }),
    ).resolves.toEqual({ created: 2, failed: 1 });

    expect(inserted.sort()).toEqual(["Ada", "Grace"]);
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.contactsListNamespace("org-1"),
    );
  });
});
