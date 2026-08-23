import { chooseSurvivor, orderPair, planMerge } from "./party-merge-plan";

describe("planMerge", () => {
  it("fills a field the survivor left empty, which is the point of merging", () => {
    const plan = planMerge({ name: "Acme", email: null }, { name: "Acme", email: "ops@acme.example" });

    expect(plan.survivorPatch).toEqual({ email: "ops@acme.example" });
    expect(plan.conflicts).toEqual({});
  });

  it("keeps the survivor's value and records the other, rather than dropping it", () => {
    // Silently discarding the loser's value is how a merge loses the phone
    // number someone actually answers.
    const plan = planMerge(
      { name: "Acme", phone: "+44 20 7946 0123" },
      { name: "Acme", phone: "+44 161 555 0100" },
    );

    expect(plan.survivorPatch).toEqual({});
    expect(plan.conflicts).toEqual({
      phone: { kept: "+44 20 7946 0123", discarded: "+44 161 555 0100" },
    });
  });

  it("treats whitespace as empty, so a blank field is filled rather than conflicting", () => {
    const plan = planMerge({ name: "Acme", website: "   " }, { name: "Acme", website: "acme.example" });
    expect(plan.survivorPatch).toEqual({ website: "acme.example" });
  });

  it("does nothing when the values already agree", () => {
    const plan = planMerge({ name: "Acme", email: "a@b.example" }, { name: "Acme", email: "a@b.example" });
    expect(plan.survivorPatch).toEqual({});
    expect(plan.conflicts).toEqual({});
  });

  it("ignores an empty value on the losing record", () => {
    const plan = planMerge({ name: "Acme", email: "a@b.example" }, { name: "Acme", email: null });
    expect(plan.survivorPatch).toEqual({});
    expect(plan.conflicts).toEqual({});
  });

  it("never carries identity or tenancy across", () => {
    const plan = planMerge(
      { name: "Acme", partyId: "keep", organizationId: "org-1" },
      { name: "Acme", partyId: "lose", organizationId: "org-2" },
    );

    expect(Object.keys(plan.survivorPatch)).not.toContain("partyId");
    expect(Object.keys(plan.survivorPatch)).not.toContain("organizationId");
  });

  it("unions custom fields, with the survivor winning a shared key", () => {
    const plan = planMerge(
      { name: "Acme", customFields: { tier: "gold", region: "north" } },
      { name: "Acme", customFields: { tier: "silver", segment: "smb" } },
    );

    expect(plan.customFields).toEqual({ tier: "gold", region: "north", segment: "smb" });
  });

  it("takes the losing record's custom fields when the survivor has none", () => {
    const plan = planMerge({ name: "Acme" }, { name: "Acme", customFields: { tier: "gold" } });
    expect(plan.customFields).toEqual({ tier: "gold" });
  });

  it("leaves custom fields null when neither side has any", () => {
    expect(planMerge({ name: "Acme" }, { name: "Acme" }).customFields).toBeNull();
  });

  it("collects several conflicts rather than stopping at the first", () => {
    const plan = planMerge(
      { name: "Acme", phone: "1", email: "a@x.example", website: "x.example" },
      { name: "Acme Ltd", phone: "2", email: "b@y.example", website: "y.example" },
    );

    expect(Object.keys(plan.conflicts).sort()).toEqual(["email", "name", "phone", "website"]);
  });
});

describe("chooseSurvivor", () => {
  const older = { partyId: "b", createdAt: new Date("2026-01-01") };
  const newer = { partyId: "a", createdAt: new Date("2026-06-01") };

  it("keeps the older record, which more things already reference", () => {
    expect(chooseSurvivor(newer, older)).toEqual({ survivor: "b", merged: "a" });
  });

  it("gives the same answer whichever way the pair is passed", () => {
    expect(chooseSurvivor(older, newer)).toEqual(chooseSurvivor(newer, older));
  });

  it("breaks a tie deterministically rather than arbitrarily", () => {
    const at = new Date("2026-01-01");
    expect(chooseSurvivor({ partyId: "z", createdAt: at }, { partyId: "a", createdAt: at })).toEqual({
      survivor: "a",
      merged: "z",
    });
  });
});

describe("orderPair", () => {
  it("orders a pair the same way whichever arrangement it is given", () => {
    expect(orderPair("b", "a")).toEqual(orderPair("a", "b"));
    expect(orderPair("a", "b")).toEqual({ low: "a", high: "b" });
  });
});
