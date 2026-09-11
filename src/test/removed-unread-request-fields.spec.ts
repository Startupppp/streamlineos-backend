import { registerSchema } from "../modules/auth/dto/auth.schemas";
import { createEpicSchema } from "../modules/build/execution/dto/iterations.schemas";
import { createBugFromResultSchema } from "../modules/build/qa/dto/qa.schemas";
import { createScorecardTemplateSchema } from "../modules/hr/interviews/dto/hr-interviews.schemas";

/**
 * Four more request fields were validated, carried and then dropped by the
 * handler. Unlike the four in `removed-speculative-request-fields.spec.ts`,
 * these became measurable only once every `@Validate({ body: S })` route
 * derived its `@Body()` from S: while the two contracts were separate
 * declarations no instrument could resolve a read, so no field on such a route
 * could be removed on tool evidence.
 *
 * A removal only counts if the boundary now REJECTS the field. A bare
 * z.object strips an unknown key silently, which leaves the removed field the
 * same no-op it already was. These assertions pin `.strict()` on each schema.
 */
describe("removed unread request fields are rejected, not stripped", () => {
  it("registerSchema rejects plan — register() always opens a TRIAL subscription", () => {
    const base = { firstName: "A", email: "a@example.com", companyName: "Co" };
    expect(registerSchema.safeParse(base).success).toBe(true);
    const withField = registerSchema.safeParse({ ...base, plan: "enterprise" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("plan");
  });

  it("createEpicSchema rejects assigneeId — createEpic writes assigneeMembershipId: undefined", () => {
    expect(createEpicSchema.safeParse({ title: "Epic" }).success).toBe(true);
    const withField = createEpicSchema.safeParse({ title: "Epic", assigneeId: "user-1" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("assigneeId");
  });

  it("createBugFromResultSchema rejects assigneeId — the bug is inserted unassigned", () => {
    expect(createBugFromResultSchema.safeParse({ title: "Bug" }).success).toBe(true);
    const withField = createBugFromResultSchema.safeParse({ title: "Bug", assigneeId: "user-1" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("assigneeId");
  });

  it("createScorecardTemplateSchema rejects isBlindMode — scorecard_templates has no such column", () => {
    const base = { name: "Template", criteria: [{ name: "Skill", weight: 1 }] };
    expect(createScorecardTemplateSchema.safeParse(base).success).toBe(true);
    const withField = createScorecardTemplateSchema.safeParse({ ...base, isBlindMode: true });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("isBlindMode");
  });
});
