import { HrDocumentTemplatesService } from "./hr-document-templates.service";
import type { CreateTemplateInput, UpdateTemplateInput } from "./dto/document-templates.schemas";

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

describe("HrDocumentTemplatesService — server-side HTML sanitization", () => {
  function buildDb(
    insertedValues: Record<string, unknown>[],
    updatedSets: Record<string, unknown>[],
    selectedRows: Record<string, unknown>[] = [],
  ) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(selectedRows),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            returning: jest.fn().mockResolvedValue([{ id: 1, ...values }]),
          };
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockImplementation((set: Record<string, unknown>) => {
              updatedSets.push(set);
              return {
                where: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([{ id: 1, ...set }]),
                }),
              };
            }),
          }),
        };
        return cb(tx);
      }),
    };
  }

  it("strips script tags and event handlers on create()", async () => {
    const insertedValues: Record<string, unknown>[] = [];
    const db = buildDb(insertedValues, []);
    const service = new HrDocumentTemplatesService(db as never);

    const input: CreateTemplateInput = {
      title: "Offer letter",
      type: "OFFER_LETTER",
      htmlContent: '<p onclick="alert(1)">Hello {{name}}</p><script>alert(1)</script>',
    };

    await service.create("org-1", "user-1", input);

    expect(insertedValues[0]?.htmlContent).toBe("<p>Hello {{name}}</p>");
  });

  it("strips script tags and event handlers on updateVersion()", async () => {
    const updatedSets: Record<string, unknown>[] = [];
    const db = buildDb([], updatedSets);
    const service = new HrDocumentTemplatesService(db as never);

    const existing = {
      id: 1,
      orgId: "org-1",
      title: "Offer letter",
      type: "OFFER_LETTER",
      htmlContent: "<p>Old</p>",
      variables: [],
      version: 1,
    } as never;

    const input: UpdateTemplateInput = {
      htmlContent: '<div><img src=x onerror="alert(1)">Updated {{name}}</div>',
    };

    await service.updateVersion("user-1", existing, input);

    expect(updatedSets[0]?.htmlContent).toBe('<div><img src="x">Updated {{name}}</div>');
  });

  it("returns no template when a different org requests its id", async () => {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    };
    const service = new HrDocumentTemplatesService(db as never);

    await expect(service.getById("org-b", 41)).resolves.toBeNull();
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-b");
  });
});
