/**
 * `sign_templates.restricted_to_roles` / `restricted_to_teams` were an authority
 * gate that gated nothing.
 *
 * Both columns (`db/schema/e-sign/templates.ts:18-19`) were accepted by the
 * create DTO, written on create, copied on duplicate and returned by `list()`
 * and `get()` — and used as a predicate nowhere. `list(orgId)` returned every
 * template in the organisation, `get()` returned any template in it, and
 * `instantiate()` never consulted them. A grep over 5,449 frontend files returns
 * zero references, so the client did not enforce them either. An administrator
 * restricted a legal template to the Legal role, the setting persisted and
 * round-tripped through the API, and every holder of `sign:templates:read`
 * still listed and instantiated it.
 *
 * The fix is to stop ACCEPTING a restriction that is not enforced, rather than
 * to start enforcing one. The stored values are free strings
 * (`z.array(z.string().trim().max(100))`) with no foreign key and no declared
 * vocabulary — nothing says whether they hold role slugs, role display names,
 * team ids or team names — so an implementation would have to guess, and a
 * wrong guess on an authority predicate locks people out of their own templates.
 * Guessing is worse than the gap.
 *
 * The COLUMNS are deliberately left in place: dropping them would destroy values
 * an administrator entered, and they are the only record of what was intended if
 * the feature is built. They are simply no longer settable, so nobody can create
 * a new false expectation.
 */
import { createTemplateSchema, updateTemplateSchema } from "./dto/e-sign.schemas";

describe("e-sign template restrictions are not accepted while they are not enforced", () => {
  it("rejects restrictedToRoles on create rather than storing an unenforced gate", () => {
    const parsed = createTemplateSchema.safeParse({
      name: "Mutual NDA",
      restrictedToRoles: ["LEGAL"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects restrictedToTeams on create", () => {
    const parsed = createTemplateSchema.safeParse({
      name: "Mutual NDA",
      restrictedToTeams: ["team-legal"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects both on update, which derives from the create shape", () => {
    expect(updateTemplateSchema.safeParse({ restrictedToRoles: ["LEGAL"] }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ restrictedToTeams: ["t1"] }).success).toBe(false);
  });

  it("still accepts everything a template legitimately carries", () => {
    const parsed = createTemplateSchema.safeParse({
      name: "Mutual NDA",
      description: "Standard two-way NDA",
      category: "legal",
      templateJson: { roles: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it("does not silently default the fields back in", () => {
    const parsed = createTemplateSchema.parse({ name: "Mutual NDA" });
    expect(parsed).not.toHaveProperty("restrictedToRoles");
    expect(parsed).not.toHaveProperty("restrictedToTeams");
  });
});
