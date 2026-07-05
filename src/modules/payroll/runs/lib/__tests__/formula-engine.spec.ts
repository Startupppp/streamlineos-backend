import { evalFormula } from "../formula-engine";
import type { FormulaScope } from "../../../payroll.types";

const scope: FormulaScope = {
  basic: 40000,
  gross: 80000,
  ctc: 100000,
  days_in_month: 30,
  paid_days: 28,
  lop_days: 2,
  overtime_hours: 4,
  incentive_amount: 5000,
  reimbursement_amount: 2000,
};

describe("formula engine", () => {
  it("evaluates literal", () => expect(evalFormula("5000", scope)).toEqual({ ok: true, value: 5000 }));
  it("adds", () => expect(evalFormula("2000 + 3000", scope)).toEqual({ ok: true, value: 5000 }));
  it("variable", () => expect(evalFormula("basic", scope)).toEqual({ ok: true, value: 40000 }));
  it("percent of basic", () => expect(evalFormula("basic * 0.4", scope)).toEqual({ ok: true, value: 16000 }));
  it("nested parens", () => expect(evalFormula("(basic + gross) / 2", scope)).toEqual({ ok: true, value: 60000 }));
  it("min function", () => expect(evalFormula("min(basic, 30000)", scope)).toEqual({ ok: true, value: 30000 }));
  it("max function", () => expect(evalFormula("max(basic, 50000)", scope)).toEqual({ ok: true, value: 50000 }));
  it("round function", () => expect(evalFormula("round(basic * 0.1, 0)", scope)).toEqual({ ok: true, value: 4000 }));
  it("division by zero returns error", () => {
    const r = evalFormula("basic / 0", scope);
    expect(r.ok).toBe(false);
  });
  it("unknown variable returns error", () => {
    const r = evalFormula("foo + 1", scope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown variable");
  });
  it("trailing operator is a syntax error", () => {
    const r = evalFormula("basic +", scope);
    expect(r.ok).toBe(false);
  });
  it("empty formula returns error", () => {
    const r = evalFormula("", scope);
    expect(r.ok).toBe(false);
  });
  it("precedence: * before +", () => expect(evalFormula("2 + 3 * 4", scope)).toEqual({ ok: true, value: 14 }));
  it("whitespace is ignored", () => expect(evalFormula("  basic   +   1000  ", scope)).toEqual({ ok: true, value: 41000 }));

  describe("unary minus and plus", () => {
    it("unary minus negates a literal", () => {
      const r = evalFormula("-500", scope);
      expect(r).toEqual({ ok: true, value: -500 });
    });

    it("unary minus negates a variable", () => {
      const r = evalFormula("-basic", scope);
      expect(r).toEqual({ ok: true, value: -40000 });
    });

    it("unary minus in expression: -basic + 500", () => {
      const r = evalFormula("-basic + 500", scope);
      expect(r).toEqual({ ok: true, value: -39500 });
    });

    it("unary plus is identity", () => {
      const r = evalFormula("+basic", scope);
      expect(r).toEqual({ ok: true, value: 40000 });
    });

    it("subtraction uses infix minus, not unary", () => {
      const r = evalFormula("basic - 500", scope);
      expect(r).toEqual({ ok: true, value: 39500 });
    });

    it("unary minus in parentheses", () => {
      const r = evalFormula("(-basic)", scope);
      expect(r).toEqual({ ok: true, value: -40000 });
    });
  });
});
