import {
  createApiKeySchema,
  createAutomationSchema,
  createGitConnectionSchema,
  customFieldsListSchema,
  featureFlagSchema,
  listAutomationsQuerySchema,
  updateAutomationSchema,
  updateGitConnectionSchema,
  updateUserRoleSchema,
} from "./settings.schemas";

const notifyAction = {
  type: "notify_all" as const,
  config: { title: "t", message: "m" },
};

describe("settings request schemas reject unknown keys", () => {
  it.each([
    ["createApiKeySchema", createApiKeySchema, { name: "key" }],
    ["customFieldsListSchema", customFieldsListSchema, { entityType: "lead" }],
    ["featureFlagSchema", featureFlagSchema, { flag: "aiChat", enabled: true }],
    [
      "createGitConnectionSchema",
      createGitConnectionSchema,
      { provider: "github", repoUrl: "https://example.com/a/b" },
    ],
    ["updateGitConnectionSchema", updateGitConnectionSchema, { isActive: true }],
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
