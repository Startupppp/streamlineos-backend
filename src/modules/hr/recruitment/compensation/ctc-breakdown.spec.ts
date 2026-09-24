import {
  buildCtcPreview,
  reconcileCtcAgainstOfferedSalary,
  totalCtc,
  type CtcBreakdown,
} from "./ctc-breakdown";

const EMPTY: CtcBreakdown = {
  fixed: null,
  variable: null,
  joiningBonus: null,
  equityValue: null,
  employerPf: null,
  gratuity: null,
};

function breakdown(overrides: Partial<CtcBreakdown>): CtcBreakdown {
  return { ...EMPTY, ...overrides };
}

describe("totalCtc", () => {
  /**
   * The defect this module exists to prevent. Summed as floats,
   * 1250000.10 + 312500.07 + 50000.03 is 1612500.2000000002 — and `.toFixed(2)`
   * would round that error out of sight rather than out of existence, leaving a
   * total that silently disagrees with `offered_salary`.
   */
  it("is exact where floating point is not", () => {
    const components = ["1250000.10", "312500.07", "50000.03"];
    const floatTotal = components.reduce((sum, v) => sum + Number(v), 0);

    expect(floatTotal).toBe(1612500.2000000002);
    expect(floatTotal).not.toBe(1612500.2);

    expect(
      totalCtc(breakdown({ fixed: components[0], variable: components[1], joiningBonus: components[2] })),
    ).toBe("1612500.20");
  });

  /**
   * A full six-component breakdown, the shape an Indian CTC sheet actually
   * takes. The float error survives every component being a plausible number.
   */
  it("stays exact across all six components", () => {
    const full = breakdown({
      fixed: "1200000.10",
      variable: "240000.07",
      employerPf: "86400.03",
      gratuity: "57692.35",
      joiningBonus: "100000.15",
      equityValue: "300000.45",
    });

    const floatTotal = [
      "1200000.10", "240000.07", "86400.03", "57692.35", "100000.15", "300000.45",
    ].reduce((sum, v) => sum + Number(v), 0);
    expect(floatTotal).not.toBe(1984093.15);

    expect(totalCtc(full)).toBe("1984093.15");
  });

  /**
   * Null is a different fact from zero. "This role has no variable pay" is a
   * term of the offer; "nobody has filled the variable in yet" is an unfinished
   * draft. An empty breakdown has no total at all rather than a total of zero.
   */
  it("distinguishes an unentered breakdown from a breakdown of zero", () => {
    expect(totalCtc(EMPTY)).toBeNull();
    expect(totalCtc(breakdown({ fixed: "0.00" }))).toBe("0.00");
    expect(totalCtc(breakdown({ fixed: "1000000.00", variable: "0.00" }))).toBe("1000000.00");
  });

  it("ignores absent components instead of reading them as zero contributions", () => {
    expect(totalCtc(breakdown({ fixed: "500000.00", gratuity: "24038.46" }))).toBe("524038.46");
  });
});

describe("reconcileCtcAgainstOfferedSalary", () => {
  /**
   * `offered_salary` is live — the handoff builds a salary structure from it and
   * the offer letter quotes it. A breakdown that does not add up to it means the
   * candidate is reading one number while payroll reads another.
   */
  it("fires when the breakdown total disagrees with offered_salary", () => {
    const result = reconcileCtcAgainstOfferedSalary(
      breakdown({ fixed: "1200000.00", variable: "240000.00" }),
      "1500000.00",
    );

    expect(result.status).toBe("MISMATCHED");
    expect(result.difference).toBe("-60000.00");
    expect(result.message).toContain("1440000.00");
    expect(result.message).toContain("1500000.00");
  });

  /** A one-paisa gap is still a gap, and is exactly what a float sum produces. */
  it("catches a disagreement of a single paisa", () => {
    const result = reconcileCtcAgainstOfferedSalary(
      breakdown({ fixed: "1250000.10", variable: "312500.07", joiningBonus: "50000.03" }),
      "1612500.19",
    );

    expect(result.status).toBe("MISMATCHED");
    expect(result.difference).toBe("0.01");
  });

  it("matches when the components add up exactly", () => {
    const result = reconcileCtcAgainstOfferedSalary(
      breakdown({ fixed: "1250000.10", variable: "312500.07", joiningBonus: "50000.03" }),
      "1612500.20",
    );

    expect(result.status).toBe("MATCHED");
    expect(result.difference).toBe("0.00");
    expect(result.message).toBeNull();
  });

  /**
   * Neither side missing is a disagreement. An offer with no breakdown, and a
   * breakdown on an offer carrying no salary, are both "nothing to compare" —
   * reporting either as a mismatch would block every offer created before this
   * column existed.
   */
  it("reports the two missing cases as not comparable rather than as a mismatch", () => {
    expect(reconcileCtcAgainstOfferedSalary(EMPTY, "1500000.00").status).toBe("NOT_COMPARABLE");
    expect(reconcileCtcAgainstOfferedSalary(breakdown({ fixed: "100.00" }), null).status)
      .toBe("NOT_COMPARABLE");
    expect(reconcileCtcAgainstOfferedSalary(EMPTY, null).difference).toBeNull();
  });

  /** A breakdown of explicit zeros against a real salary is a real mismatch. */
  it("treats an all-zero breakdown as comparable, not as absent", () => {
    const result = reconcileCtcAgainstOfferedSalary(breakdown({ fixed: "0.00" }), "1200000.00");
    expect(result.status).toBe("MISMATCHED");
    expect(result.difference).toBe("-1200000.00");
  });
});

describe("buildCtcPreview", () => {
  const offer = breakdown({
    fixed: "1200000.00",
    variable: "240000.00",
    employerPf: "86400.00",
    gratuity: "57692.00",
    joiningBonus: "100000.00",
    equityValue: "300000.00",
  });

  it("renders only the components somebody entered, in reading order", () => {
    const preview = buildCtcPreview(breakdown({ fixed: "1200000.00", variable: "0.00" }), null);

    expect(preview.lines.map((l) => l.key)).toEqual(["fixed", "variable"]);
    expect(preview.lines[1].annual).toBe("0.00");
  });

  it("omits an unentered component entirely rather than showing it as zero", () => {
    const preview = buildCtcPreview(breakdown({ fixed: "1200000.00" }), null);

    expect(preview.lines).toHaveLength(1);
    expect(preview.lines.map((l) => l.key)).not.toContain("variable");
    expect(preview.lumpSumTotal).toBeNull();
  });

  /**
   * The rendered monthly column has to add up to its own footer. Rounding each
   * line and then dividing the annual total separately gives a table a candidate
   * can catch out with a calculator — on the one page whose purpose is that they
   * can check the arithmetic.
   */
  it("totals the monthly column from the lines it actually rendered", () => {
    const preview = buildCtcPreview(breakdown({ fixed: "1000000.00", variable: "1000000.00" }), null);

    expect(preview.lines.map((l) => l.monthly)).toEqual(["83333.33", "83333.33"]);
    expect(preview.monthlyTotal).toBe("166666.66");

    const summedFromLines = preview.lines
      .map((l) => l.monthly)
      .filter((m): m is string => m !== null)
      .reduce((sum, m) => sum + Number(m.replace(".", "")), 0);
    expect(summedFromLines).toBe(16666666);
  });

  it("divides evenly where the annual divides evenly", () => {
    const preview = buildCtcPreview(breakdown({ fixed: "1200000.00" }), null);
    expect(preview.lines[0].monthly).toBe("100000.00");
  });

  /**
   * A joining bonus is paid once and equity is not cash. Rendering either as a
   * monthly figure states a recurring payment the company never offered, so both
   * are held out of the monthly column and the monthly total.
   */
  it("keeps one-time pay out of the monthly view", () => {
    const preview = buildCtcPreview(offer, null);

    const lump = preview.lines.filter((l) => l.recurrence === "LUMP_SUM");
    expect(lump.map((l) => l.key)).toEqual(["joiningBonus", "equityValue"]);
    expect(lump.every((l) => l.monthly === null)).toBe(true);

    expect(preview.annualTotal).toBe("1984092.00");
    expect(preview.lumpSumTotal).toBe("400000.00");
    expect(preview.monthlyTotal).toBe("132007.67");
  });

  it("has no totals at all when nothing was entered", () => {
    const preview = buildCtcPreview(EMPTY, "1500000.00");

    expect(preview.lines).toEqual([]);
    expect(preview.annualTotal).toBeNull();
    expect(preview.monthlyTotal).toBeNull();
    expect(preview.lumpSumTotal).toBeNull();
  });

  /**
   * A value the column could not hold must not be absorbed as a zero. Saying so
   * is the difference between a total that is wrong and a total that says it is
   * incomplete.
   */
  it("names a component it could not parse instead of folding it in as zero", () => {
    const preview = buildCtcPreview(breakdown({ fixed: "1200000.00", variable: "12.345" }), null);

    expect(preview.malformed).toEqual(["variable"]);
    expect(preview.lines.map((l) => l.key)).toEqual(["fixed"]);
    expect(preview.annualTotal).toBe("1200000.00");
  });

  /**
   * The public offer page is unauthenticated and is where somebody accepts a
   * job. A value that reaches it as a number rather than the column's string —
   * a fixture, a JSON body, a client that coerces — has to become a reported
   * component, never a TypeError inside `.trim()` that blanks the page.
   */
  it("survives a component arriving as something other than the column's string", () => {
    const fromTheWire: CtcBreakdown = JSON.parse(
      '{"fixed":"1200000.00","variable":240000,"joiningBonus":null,"equityValue":null,"employerPf":null,"gratuity":null}',
    );

    const preview = buildCtcPreview(fromTheWire, "1200000.00");
    expect(preview.malformed).toEqual(["variable"]);
    expect(preview.annualTotal).toBe("1200000.00");
    expect(preview.reconciliation.status).toBe("MATCHED");
  });

  it("carries the reconciliation verdict onto the preview it renders", () => {
    expect(buildCtcPreview(offer, "1984092.00").reconciliation.status).toBe("MATCHED");
    expect(buildCtcPreview(offer, "2000000.00").reconciliation.status).toBe("MISMATCHED");
    expect(buildCtcPreview(offer, "2000000.00").reconciliation.difference).toBe("-15908.00");
  });
});
