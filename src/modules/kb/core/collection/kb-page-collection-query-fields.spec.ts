import { kbPageCollectionQuerySchema } from "../dto/kb.schemas";
import { KB_PAGE_COLLECTION_QUERY_FIELDS } from "./knowledge-collection.types";

describe("KB_PAGE_COLLECTION_QUERY_FIELDS — the cross-repo fixture pinning the collection query shape", () => {
  it("names exactly the keys kbPageCollectionQuerySchema accepts, so a field added on one side without the other is caught here first", () => {
    const schemaKeys = Object.keys(kbPageCollectionQuerySchema.shape).sort();
    const fixtureKeys = [...KB_PAGE_COLLECTION_QUERY_FIELDS].sort();

    expect(fixtureKeys).toEqual(schemaKeys);
  });

  it("rejects a query key the fixture does not name, because the schema is .strict()", () => {
    const probe: Record<string, unknown> = { sort: "updated_desc", limit: 50 };
    for (const field of KB_PAGE_COLLECTION_QUERY_FIELDS) probe[field] = undefined;
    probe.notARealFilterField = "x";

    expect(() => kbPageCollectionQuerySchema.parse(probe)).toThrow();
  });
});
