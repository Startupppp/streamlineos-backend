import { ContactsService } from "./contacts.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";

describe("ContactsService bulk import", () => {
  it("projects only public identity fields from contact relations", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new ContactsService(
      { query: { contacts: { findFirst } } } as never,
      {} as never,
      {} as never,
    );

    await service.getContact("org-1", 42);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        with: {
          crmOrganization: { columns: { id: true, name: true } },
          lead: { columns: { id: true, name: true } },
          deal: { columns: { id: true, name: true } },
        },
      }),
    );
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
      where: jest.fn(),
      orderBy: jest.fn(),
      limit,
    };
    query.from.mockReturnValue(query);
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

  it("uses one bulk insert for a valid import", async () => {
    const values = jest.fn().mockResolvedValue(undefined);
    const tx = { insert: jest.fn(() => ({ values })) };
    const db = { transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const limits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactsService(db as never, cache as never, limits as never);

    await expect(
      service.bulkImport("org-1", {
        contacts: [
          { name: "Ada", email: "ada@example.com" },
          { name: "Grace", email: "grace@example.com" },
        ],
      }),
    ).resolves.toEqual({ created: 2, failed: 0 });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ orgId: "org-1", name: "Ada" })]),
    );
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.contactsListNamespace("org-1"),
    );
  });

  it("bisects a rejected batch and retains partial-success counts", async () => {
    const inserted: string[] = [];
    const db = {
      transaction: jest.fn(async (work: (client: unknown) => unknown) => {
        const tx = {
          insert: () => ({
            values: async (rows: Array<{ name: string }>) => {
              if (rows.some((row) => row.name === "Invalid")) throw new Error("constraint");
              inserted.push(...rows.map((row) => row.name));
            },
          }),
        };
        return work(tx);
      }),
    };
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const limits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactsService(db as never, cache as never, limits as never);

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
