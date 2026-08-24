import {
  describeActor,
  fromMinorUnits,
  isStageChange,
  toMinorUnits,
  toTransitionRow,
  type StageTransitionInput,
} from "./deal-stage-ledger";

const BASE: Omit<StageTransitionInput, "actor"> = {
  organizationId: "org-1",
  dealId: 42,
  pipelineId: "pipe-1",
  fromStage: "QUALIFIED",
  toStage: "PROPOSAL",
};

describe("toTransitionRow", () => {
  it("records a person by id and carries no label", () => {
    const row = toTransitionRow({ ...BASE, actor: { kind: "human", userId: "user-9" } });

    expect(row).toMatchObject({
      actorKind: "human",
      actorUserId: "user-9",
      actorLabel: null,
    });
  });

  it("records the system by label and carries no user", () => {
    const row = toTransitionRow({
      ...BASE,
      actor: { kind: "system", label: "stage-inference v3" },
    });

    expect(row).toMatchObject({
      actorKind: "system",
      actorUserId: null,
      actorLabel: "stage-inference v3",
    });
  });

  it("keeps the two halves mutually exclusive, as the CHECK constraint does", () => {
    const human = toTransitionRow({ ...BASE, actor: { kind: "human", userId: "user-9" } });
    const system = toTransitionRow({ ...BASE, actor: { kind: "system", label: "automation" } });

    expect(human.actorUserId !== null && human.actorLabel === null).toBe(true);
    expect(system.actorUserId === null && system.actorLabel !== null).toBe(true);
  });

  it("carries a null previous stage for a deal's first move", () => {
    const row = toTransitionRow({
      ...BASE,
      fromStage: null,
      actor: { kind: "human", userId: "user-9" },
    });

    expect(row.fromStage).toBeNull();
  });

  it("normalises a blank reason to null rather than storing whitespace", () => {
    const row = toTransitionRow({
      ...BASE,
      reason: "   ",
      actor: { kind: "human", userId: "user-9" },
    });

    expect(row.reason).toBeNull();
  });

  it("trims a reason that was given", () => {
    const row = toTransitionRow({
      ...BASE,
      reason: "  Customer confirmed budget  ",
      actor: { kind: "system", label: "extraction" },
    });

    expect(row.reason).toBe("Customer confirmed budget");
  });
});

describe("describeActor", () => {
  it("names the system by what actually did it", () => {
    expect(describeActor({ actorKind: "system", actorLabel: "stage-inference v3" })).toBe(
      "stage-inference v3",
    );
  });

  it("names a person, never an identifier", () => {
    expect(
      describeActor({ actorKind: "human", actorLabel: null, actorName: "Priya Raman" }),
    ).toBe("Priya Raman");
  });

  it("falls back to a readable phrase rather than rendering a raw id", () => {
    expect(describeActor({ actorKind: "human", actorLabel: null })).toBe("A team member");
    expect(describeActor({ actorKind: "system", actorLabel: null })).toBe("The system");
  });
});

describe("isStageChange", () => {
  it.each([
    ["QUALIFIED", "PROPOSAL", true],
    ["PROPOSAL", "PROPOSAL", false],
    [null, "LEAD", true],
    ["LEAD", null, false],
    [undefined, undefined, false],
  ])("from %s to %s is %s", (from, to, expected) => {
    expect(isStageChange(from as string | null, to as string | null)).toBe(expected);
  });
});

describe("toMinorUnits", () => {
  it.each([
    [1234.56, 123456],
    ["1234.56", 123456],
    [0, 0],
    ["0", 0],
    [10, 1000],
    ["10", 1000],
    ["10.5", 1050],
    ["10.509", 1050],
    [-42.5, -4250],
    ["-42.50", -4250],
  ])("converts %s to %s minor units", (input, expected) => {
    expect(toMinorUnits(input as number | string)).toBe(expected);
  });

  /**
   * The reason this does not multiply by 100.
   *
   * 1234.56 * 100 is 123455.99999999999 in IEEE 754, so a naive Math.round is
   * right here and wrong elsewhere; scaling the decimal text never is.
   */
  it("does not lose the cent that floating-point multiplication loses", () => {
    expect(toMinorUnits("1234.56")).toBe(123456);
    expect(toMinorUnits("8.29")).toBe(829);
    expect(toMinorUnits("1.005")).toBe(100);
  });

  it.each([[null], [undefined], [""], ["not a number"], ["-"]])(
    "treats %s as nothing rather than NaN",
    (input) => {
      expect(toMinorUnits(input as string | null)).toBe(0);
    },
  );
});

describe("fromMinorUnits", () => {
  it.each([
    [123456, "1234.56"],
    [0, "0.00"],
    [5, "0.05"],
    [1000, "10.00"],
    [-4250, "-42.50"],
  ])("renders %s as %s", (input, expected) => {
    expect(fromMinorUnits(input)).toBe(expected);
  });

  it("round-trips every value it is given", () => {
    for (const amount of ["0.00", "1234.56", "8.29", "0.05", "-42.50", "999999.99"])
      expect(fromMinorUnits(toMinorUnits(amount))).toBe(amount);
  });
});
