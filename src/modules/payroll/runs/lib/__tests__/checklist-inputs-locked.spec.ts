import { buildInputsLockedChecklistItem } from "../checklist";

describe("buildInputsLockedChecklistItem (freeze before pay)", () => {
  it("is done when freeze-before-pay is off (optional path)", () => {
    const item = buildInputsLockedChecklistItem(false, false);
    expect(item.key).toBe("inputs_locked");
    expect(item.done).toBe(true);
    expect(item.href).toBe("/payroll/inputs");
    expect(item.detail).toMatch(/Optional/i);
  });

  it("is not done when freeze required and period unlocked", () => {
    const item = buildInputsLockedChecklistItem(true, false);
    expect(item.done).toBe(false);
    expect(item.detail).toMatch(/lock/i);
  });

  it("is done when freeze required and period locked", () => {
    const item = buildInputsLockedChecklistItem(true, true);
    expect(item.done).toBe(true);
    expect(item.detail).toMatch(/locked and immutable/i);
  });
});
