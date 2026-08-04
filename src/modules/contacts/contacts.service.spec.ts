import { ContactsService } from "./contacts.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";

describe("ContactsService bulk import", () => {
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
