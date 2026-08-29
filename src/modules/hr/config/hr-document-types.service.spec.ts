import { HrDocumentTypesService } from "./hr-document-types.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

describe("HrDocumentTypesService cross-tenant isolation", () => {
  it("returns no document type when a different org requests its id", async () => {
    const db = {
      query: {
        documentTypes: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    };
    const service = new HrDocumentTypesService(db as never);

    await expect(service.getById("org-b", 41)).resolves.toBeNull();
    expect(db.query.documentTypes.findFirst).toHaveBeenCalledTimes(1);
    expect(sqlValues(db.query.documentTypes.findFirst.mock.calls[0]?.[0]?.where)).toContain(
      "org-b",
    );
  });
});
