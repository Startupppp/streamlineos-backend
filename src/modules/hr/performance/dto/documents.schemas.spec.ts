import {
  listDocumentsSchema,
  renderLetterSchema,
  saveLetterSchema,
} from "./documents.schemas";

describe("document API schemas", () => {
  it("defaults to a bounded cursor page and rejects offset parameters", () => {
    expect(listDocumentsSchema.parse({})).toEqual({ limit: 20 });
    expect(listDocumentsSchema.safeParse({ page: 2 }).success).toBe(false);
    expect(listDocumentsSchema.parse({ limit: 101 }).limit).toBe(100);
  });

  it.each([renderLetterSchema, saveLetterSchema])(
    "accepts one descriptive employee target and rejects conflicting targets",
    (schema) => {
      const base = schema === renderLetterSchema
        ? { templateId: 7 }
        : {
            templateId: 7,
            templateVersion: 1,
            outputHtml: "<p>Offer</p>",
          };

      expect(
        schema.safeParse({ ...base, employeeUserId: "user-7" }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          ...base,
          employmentId: 11,
          employeeUserId: "user-7",
        }).success,
      ).toBe(false);
    },
  );
});
