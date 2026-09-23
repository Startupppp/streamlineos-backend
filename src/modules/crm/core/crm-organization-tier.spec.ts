import {
  organizationCreateSchema,
  organizationUpdateSchema,
} from "./dto/organizations.schemas";
import {
  crmOrgSchema,
  crmOrgWithContactsSchema,
} from "./dto/crm-organizations-response.schemas";
import { CRM_ACCOUNT_TIERS } from "./dto/organizations.schemas";

/**
 * The human-entered tier is the only customer-value input the roadmap is allowed
 * to weight by, so the contract that carries it is pinned on both directions.
 */

describe("organizationCreateSchema — tier is settable at the company's own door", () => {
  it("accepts each of the three tiers the enum defines", () => {
    for (const tier of CRM_ACCOUNT_TIERS)
      expect(organizationCreateSchema.parse({ name: "Acme", tier }).tier).toBe(tier);
  });

  it("leaves tier undefined when it is not sent, so an existing form is not forced to pick one", () => {
    expect(organizationCreateSchema.parse({ name: "Acme" }).tier).toBeUndefined();
  });

  it("rejects a tier the enum does not define rather than storing a value no weight knows", () => {
    expect(() => organizationCreateSchema.parse({ name: "Acme", tier: "platinum" })).toThrow();
  });

  it("still rejects an unknown key, so .strict() was not widened to admit tier (BE-13)", () => {
    expect(() => organizationCreateSchema.parse({ name: "Acme", accountTier: "pro" })).toThrow();
  });
});

describe("organizationUpdateSchema — a tier can be corrected and it can be withdrawn", () => {
  it("accepts a tier on update", () => {
    expect(organizationUpdateSchema.parse({ tier: "enterprise" }).tier).toBe("enterprise");
  });

  it("accepts an explicit null so an operator can withdraw a tier they set by mistake", () => {
    expect(organizationUpdateSchema.parse({ tier: null }).tier).toBeNull();
  });

  it("rejects an invalid tier on update as well as on create", () => {
    expect(() => organizationUpdateSchema.parse({ tier: "gold" })).toThrow();
  });

  it("still rejects an unknown key on update (BE-13)", () => {
    expect(() => organizationUpdateSchema.parse({ tierName: "pro" })).toThrow();
  });
});

describe("the organization response publishes the tier it was created with", () => {
  const listRow = {
    id: 1,
    name: "Acme",
    domain: null,
    industry: null,
    size: null,
    website: null,
    linkedinUrl: null,
    description: null,
    tier: "pro",
    createdAt: new Date(0),
  };

  it("round-trips a tier set on create back out of the list projection", () => {
    expect(crmOrgSchema.parse(listRow).tier).toBe("pro");
  });

  it("publishes null for a company nobody has tiered yet, rather than omitting the field", () => {
    const parsed = crmOrgSchema.parse({ ...listRow, tier: null });
    expect(parsed).toHaveProperty("tier", null);
  });

  it("rejects a tier the enum does not define on the way out, so a bad write cannot be laundered", () => {
    expect(() => crmOrgSchema.parse({ ...listRow, tier: "platinum" })).toThrow();
  });

  it("carries the tier on the detail response the PATCH handler returns", () => {
    const detail = crmOrgWithContactsSchema.parse({
      id: 1,
      orgId: "org-1",
      parentId: null,
      mergedIntoId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      name: "Acme",
      domain: null,
      industry: null,
      size: null,
      website: null,
      linkedinUrl: null,
      description: null,
      tier: "enterprise",
      contacts: [],
    });
    expect(detail.tier).toBe("enterprise");
  });
});
