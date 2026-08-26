import { REPAIR_CLASSES } from "../../db/schema/crm/autonomy-repairs";
import type { SwitchDecision } from "./kill-switch";
import {
  CONSERVATIVE_REPAIR_CLASSES,
  REPAIR_CLASS_DEFINITIONS,
  effectiveRepairPolicy,
  mayRepair,
  proposeRepair,
  repairClassesForFindingKind,
  type RepairPolicyRow,
} from "./repair-classes";

const allowed: SwitchDecision = { allowed: true, decidedBy: "default", reason: null };
const platformOff: SwitchDecision = {
  allowed: false,
  decidedBy: "platform-all",
  reason: "incident 42",
};
const orgOff: SwitchDecision = { allowed: false, decidedBy: "org-kind", reason: null };

const ask = (repairClass: string, policies: RepairPolicyRow[] = [], sw = allowed) =>
  mayRepair(repairClass, { autonomySwitch: sw, policies });

describe("may this class be repaired for this tenant", () => {
  /**
   * The default is the answer to every question this predicate is asked before
   * anybody has configured anything, so it is the one that has to be right.
   */
  it("refuses a class nobody has enabled and the enumeration does not call conservative", () => {
    const decision = ask("email.whitespace");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("class-not-enabled");
  });

  it("allows a conservative class with no tenant row at all", () => {
    const decision = ask("email.domain-dot-edge");

    expect(decision.allowed).toBe(true);
    expect(decision.decidedBy).toBe("conservative-default");
  });

  /**
   * An unknown class is the failure mode this file exists to make impossible: a
   * caller inventing a name must not fall through to "no row, so use the
   * default" and be told yes.
   */
  it("refuses a class that is not in the enumeration", () => {
    const decision = ask("merge-parties");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown-class");
  });

  it("refuses an unknown class even when a policy row claims to enable it", () => {
    const decision = ask("party.deleted", [{ repairClass: "party.deleted", enabled: true }]);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown-class");
  });

  it("lets a tenant grant a class the enumeration defaults to off", () => {
    const decision = ask("email.whitespace", [{ repairClass: "email.whitespace", enabled: true }]);

    expect(decision.allowed).toBe(true);
    expect(decision.decidedBy).toBe("tenant-enabled");
  });

  it("lets a tenant revoke a class the enumeration defaults to on", () => {
    const decision = ask("email.domain-dot-edge", [
      { repairClass: "email.domain-dot-edge", enabled: false },
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("tenant-disabled");
  });

  it("ignores another class's row", () => {
    const decision = ask("email.whitespace", [
      { repairClass: "email.domain-dot-edge", enabled: true },
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("class-not-enabled");
  });

  /**
   * The kill switch is the wider veto and has to beat a tenant's grant, or an
   * operator stopping autonomy platform-wide would be overridden by whichever
   * tenants had opted in.
   */
  it("refuses everything while autonomy itself is switched off, however enabled the class", () => {
    const decision = ask(
      "email.whitespace",
      [{ repairClass: "email.whitespace", enabled: true }],
      platformOff,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("autonomy-off");
    expect(decision.explanation).toContain("incident 42");
  });

  it("refuses a conservative class while the organisation has switched repairs off", () => {
    const decision = ask("phone.non-ascii-characters", [], orgOff);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("autonomy-off");
  });

  it("always states a reason a person can read", () => {
    for (const decision of [
      ask("email.whitespace"),
      ask("merge-parties"),
      ask("email.domain-dot-edge", [], platformOff),
      ask("email.domain-dot-edge", [{ repairClass: "email.domain-dot-edge", enabled: false }]),
    ]) {
      expect(decision.allowed).toBe(false);
      expect(decision.explanation.length).toBeGreaterThan(10);
    }
  });
});

describe("the enumeration itself", () => {
  it("is closed, and a merge is not in it", () => {
    expect([...REPAIR_CLASSES]).toEqual([
      "email.whitespace",
      "email.domain-dot-edge",
      "phone.non-ascii-characters",
    ]);
    expect(REPAIR_CLASSES).not.toContain("merge-parties");
  });

  /**
   * The whole selection rule, asserted rather than described. Every class is a
   * single reversing write by construction; a class that were not would promise
   * an undo the ledger cannot deliver.
   */
  it("classes every repair as instantly reversible", () => {
    for (const key of REPAIR_CLASSES)
      expect(REPAIR_CLASS_DEFINITIONS[key].reversibility).toBe("instant");
  });

  it("names, for every class, the finding it repairs and the field it rewrites", () => {
    for (const key of REPAIR_CLASSES) {
      const definition = REPAIR_CLASS_DEFINITIONS[key];
      expect(definition.repairClass).toBe(key);
      expect(definition.findingKind.length).toBeGreaterThan(0);
      expect(["email", "phone"]).toContain(definition.field);
      expect(definition.description.length).toBeGreaterThan(20);
    }
  });

  it("keeps the conservative set a strict subset, so ticket 11 has something to grant", () => {
    expect([...CONSERVATIVE_REPAIR_CLASSES]).toEqual([
      "email.domain-dot-edge",
      "phone.non-ascii-characters",
    ]);
    expect(CONSERVATIVE_REPAIR_CLASSES).not.toContain("email.whitespace");
  });

  it("finds the classes that could repair a finding kind, and none for one it cannot", () => {
    expect(repairClassesForFindingKind("reachability.malformed-email")).toEqual([
      "email.whitespace",
      "email.domain-dot-edge",
    ]);
    expect(repairClassesForFindingKind("reachability.malformed-phone")).toEqual([
      "phone.non-ascii-characters",
    ]);
    expect(repairClassesForFindingKind("duplicate.party-pair")).toEqual([]);
    expect(repairClassesForFindingKind("staleness.no-contact")).toEqual([]);
  });

  it("reports the effective answer per class for a tenant, defaults included", () => {
    const effective = effectiveRepairPolicy([{ repairClass: "email.whitespace", enabled: true }]);

    expect(effective).toEqual([
      expect.objectContaining({
        repairClass: "email.whitespace",
        enabled: true,
        source: "tenant",
        conservative: false,
      }),
      expect.objectContaining({
        repairClass: "email.domain-dot-edge",
        enabled: true,
        source: "default",
        conservative: true,
      }),
      expect.objectContaining({
        repairClass: "phone.non-ascii-characters",
        enabled: true,
        source: "default",
        conservative: true,
      }),
    ]);
  });
});

describe("proposing one repair", () => {
  it("refuses a class it has never heard of rather than guessing", () => {
    const proposal = proposeRepair("phone.add-country-code", "9876543210");

    expect(proposal.ok).toBe(false);
    if (!proposal.ok) expect(proposal.reason).toBe("unknown-class");
  });

  describe("email.whitespace", () => {
    const propose = (value: string) => proposeRepair("email.whitespace", value);

    it("deletes whitespace that sits where an address cannot contain any", () => {
      const proposal = propose("john.smith @acme.com");

      expect(proposal).toEqual({ ok: true, next: "john.smith@acme.com" });
    });

    it("deletes whitespace inside the domain", () => {
      expect(propose("john@acme .com")).toEqual({ ok: true, next: "john@acme.com" });
    });

    /**
     * The refusal that keeps this class admissible at all. Two plausible
     * readings, so no reading.
     */
    it("refuses whitespace between two characters of the local part", () => {
      const proposal = propose("john smith@acme.com");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("ambiguous");
    });

    it("refuses when deleting the whitespace still leaves a broken address", () => {
      const proposal = propose("john.smith @acme");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("still-invalid");
    });

    it("refuses a value that has no whitespace to delete", () => {
      const proposal = propose("john@acme.com");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("not-the-shape");
    });

    it("refuses a value with more than one @, which is a different problem", () => {
      const proposal = propose("john @acme@example.com");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("not-the-shape");
    });
  });

  describe("email.domain-dot-edge", () => {
    const propose = (value: string) => proposeRepair("email.domain-dot-edge", value);

    it("removes a trailing root dot", () => {
      expect(propose("john@acme.com.")).toEqual({ ok: true, next: "john@acme.com" });
    });

    it("removes a leading dot", () => {
      expect(propose("john@.acme.com")).toEqual({ ok: true, next: "john@acme.com" });
    });

    it("refuses a domain whose dots are not at an edge", () => {
      const proposal = propose("john@acme.com");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("not-the-shape");
    });

    it("refuses when stripping the edge dots leaves nothing that is a domain", () => {
      const proposal = propose("john@.com.");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("still-invalid");
    });
  });

  describe("phone.non-ascii-characters", () => {
    const propose = (value: string) => proposeRepair("phone.non-ascii-characters", value);

    it("maps fullwidth digits onto ASCII without changing a digit", () => {
      expect(propose("＋９１ ９８７６５４３２１０")).toEqual({
        ok: true,
        next: "+91 9876543210",
      });
    });

    it("maps Arabic-Indic digits", () => {
      expect(propose("٩٨٧٦٥٤٣٢١٠")).toEqual({ ok: true, next: "9876543210" });
    });

    it("maps a typographic dash and a non-breaking space", () => {
      expect(propose("+91 98765‑43210")).toEqual({ ok: true, next: "+91 98765-43210" });
    });

    it("refuses a value that is already ASCII, however wrong it is", () => {
      const proposal = propose("98765");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("not-the-shape");
    });

    it("refuses a non-ASCII character with no ASCII equivalent", () => {
      const proposal = propose("+91 98765 43210 ☎");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("ambiguous");
    });

    /**
     * Where the country code is missing, mapping the script does not make the
     * number dialable — and inventing the missing digits is the choice this
     * whole enumeration exists to refuse.
     */
    it("refuses when the mapped digits still do not make a dialable number", () => {
      const proposal = propose("９８７６５");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("ambiguous");
    });

    it("refuses letters, which are their own unrepairable problem", () => {
      const proposal = propose("＋９１ 9876543210 ext 4");

      expect(proposal.ok).toBe(false);
      if (!proposal.ok) expect(proposal.reason).toBe("ambiguous");
    });
  });

  /**
   * The property that makes "reversible" true rather than hoped for: applying a
   * repair to its own output changes nothing, so a second sweep cannot walk a
   * value away from where the first left it.
   */
  it("is idempotent — a repaired value is no longer of the shape", () => {
    for (const [key, value] of [
      ["email.whitespace", "john.smith @acme.com"],
      ["email.domain-dot-edge", "john@acme.com."],
      ["phone.non-ascii-characters", "＋９１ ９８７６５４３２１０"],
    ] as const) {
      const first = proposeRepair(key, value);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;

      const second = proposeRepair(key, first.next);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("not-the-shape");
    }
  });
});
