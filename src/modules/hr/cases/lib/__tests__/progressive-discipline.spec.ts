import { checkProgressiveDiscipline } from "../../progressive-discipline";

describe("progressive discipline", () => {
  it("allows verbal warning always", () => {
    expect(checkProgressiveDiscipline("verbal_warning", []).ok).toBe(true);
  });

  it("blocks final_warning without prior written", () => {
    const r = checkProgressiveDiscipline("final_warning", ["verbal_warning"]);
    expect(r.ok).toBe(false);
    expect(r.missingPrior).toBe("written_warning");
  });

  it("allows final_warning after written", () => {
    expect(
      checkProgressiveDiscipline("final_warning", ["verbal_warning", "written_warning"]).ok,
    ).toBe(true);
  });

  it("allows force escalate with warning", () => {
    const r = checkProgressiveDiscipline("suspension", [], true);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/Forced escalate/i);
  });
});
