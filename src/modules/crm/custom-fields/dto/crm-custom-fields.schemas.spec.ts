import {
  CRM_CUSTOM_FIELD_ENTITY_TYPES,
  createCustomFieldSchema,
  customFieldsListSchema,
  updateCustomFieldSchema,
} from "./crm-custom-fields.schemas";

const validCreate = {
  entityType: "lead" as const,
  name: "deal_source",
  label: "Deal source",
};

describe("crm custom field schemas reject unknown keys", () => {
  it.each([
    ["customFieldsListSchema", customFieldsListSchema, { entityType: "lead" }],
    ["createCustomFieldSchema", createCustomFieldSchema, validCreate],
    ["updateCustomFieldSchema", updateCustomFieldSchema, { label: "Renamed" }],
  ])("%s accepts its declared body and refuses an extra field", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, orgId: "org-2" }).success).toBe(false);
  });

  it("refuses an unknown key inside a select option", () => {
    expect(
      createCustomFieldSchema.safeParse({
        ...validCreate,
        fieldType: "select",
        options: [{ value: "a", label: "A" }],
      }).success,
    ).toBe(true);
    expect(
      createCustomFieldSchema.safeParse({
        ...validCreate,
        fieldType: "select",
        options: [{ value: "a", label: "A", colour: "red" }],
      }).success,
    ).toBe(false);
  });
});

/**
 * The enum is the evidence that this surface is CRM-only, which is what let the
 * four routes move onto a CRM rung. A foreign entity type must not parse, or the
 * route reaches Support and HR definitions again through a CRM path.
 */
describe("crm custom field schemas own only the CRM entity types", () => {
  it("names exactly lead, deal and contact", () => {
    expect([...CRM_CUSTOM_FIELD_ENTITY_TYPES]).toEqual(["lead", "deal", "contact"]);
  });

  it.each(["ticket", "employee", "project"])("refuses %s on the filter", (entityType) => {
    expect(customFieldsListSchema.safeParse({ entityType }).success).toBe(false);
  });

  it.each(["ticket", "employee", "project"])("refuses %s on a create", (entityType) => {
    expect(createCustomFieldSchema.safeParse({ ...validCreate, entityType }).success).toBe(
      false,
    );
  });
});
