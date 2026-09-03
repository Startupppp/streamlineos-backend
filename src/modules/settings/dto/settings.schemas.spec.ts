import {
  createApiKeySchema,
  createAutomationSchema,
  featureFlagSchema,
  listAutomationsQuerySchema,
  updateAutomationSchema,
  updateUserRoleSchema,
} from "./settings.schemas";

const notifyAction = {
  type: "notify_all" as const,
  config: { title: "t", message: "m" },
};

describe("settings request schemas reject unknown keys", () => {
  it.each([
    ["createApiKeySchema", createApiKeySchema, { name: "key" }],
    ["featureFlagSchema", featureFlagSchema, { flag: "aiChat", enabled: true }],
    [
      "createAutomationSchema",
      createAutomationSchema,
      { name: "rule", triggerEvent: "lead.created", actions: [notifyAction] },
    ],
    ["updateAutomationSchema", updateAutomationSchema, { name: "rule" }],
    ["updateUserRoleSchema", updateUserRoleSchema, { role: "ORG_ADMIN" }],
    ["listAutomationsQuerySchema", listAutomationsQuerySchema, { limit: 10 }],
  ])("%s accepts its declared body and refuses an extra field", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, orgId: "org-2" }).success).toBe(false);
  });
});

/**
 * The top-level object was strict while everything nested inside it was not, so
 * a misspelt key in `actions[].config` or in a condition parsed clean and the
 * rule was stored doing something other than what was asked for. `.strict()` at
 * the outer boundary only guards the outer boundary.
 */
describe("automation bodies are strict all the way down", () => {
  const rule = (actions: unknown[], conditions: unknown[] = []) => ({
    name: "rule",
    triggerEvent: "lead.created",
    conditions,
    actions,
  });

  it("refuses an unknown key inside an action's config", () => {
    expect(createAutomationSchema.safeParse(rule([notifyAction])).success).toBe(true);
    expect(
      createAutomationSchema.safeParse(
        rule([{ type: "notify_all", config: { title: "t", message: "m", lnik: "typo" } }]),
      ).success,
    ).toBe(false);
  });

  it("refuses an unknown key beside an action's discriminator", () => {
    expect(
      createAutomationSchema.safeParse(rule([{ ...notifyAction, scope: "all" }])).success,
    ).toBe(false);
  });

  it("refuses an unknown key inside a condition", () => {
    expect(
      createAutomationSchema.safeParse(rule([notifyAction], [{ field: "status", op: "eq" }]))
        .success,
    ).toBe(true);
    expect(
      createAutomationSchema.safeParse(
        rule([notifyAction], [{ field: "status", op: "eq", vaule: "NEW" }]),
      ).success,
    ).toBe(false);
  });
});

describe("settings request schemas bound growing arrays", () => {
  const scopes = (count: number) =>
    Array.from({ length: count }, (_, i) => `scope-${i}`);

  it("caps API key scopes", () => {
    expect(createApiKeySchema.safeParse({ name: "k", scopes: scopes(100) }).success).toBe(
      true,
    );
    expect(createApiKeySchema.safeParse({ name: "k", scopes: scopes(101) }).success).toBe(
      false,
    );
  });

  it("caps automation actions and conditions", () => {
    const many = (count: number) => Array.from({ length: count }, () => notifyAction);
    const conditions = (count: number) =>
      Array.from({ length: count }, () => ({ field: "status", op: "eq" as const }));

    expect(
      createAutomationSchema.safeParse({
        name: "rule",
        triggerEvent: "lead.created",
        actions: many(51),
      }).success,
    ).toBe(false);
    expect(
      createAutomationSchema.safeParse({
        name: "rule",
        triggerEvent: "lead.created",
        actions: [notifyAction],
        conditions: conditions(51),
      }).success,
    ).toBe(false);
  });
});
