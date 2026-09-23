import { approvalPriority } from "./approval-priority";

const PAST = new Date("2026-09-01T00:00:00Z");
const NOW = new Date("2026-09-23T12:00:00Z");
const FUTURE = new Date("2026-09-30T00:00:00Z");

describe("approvalPriority — escalated status", () => {
  it("BITE: escalated status returns HIGH regardless of dueAt", () => {
    expect(approvalPriority(FUTURE, "escalated", NOW)).toBe("HIGH");
  });

  it("escalated with null dueAt still returns HIGH — escalation IS the priority signal", () => {
    expect(approvalPriority(null, "escalated", NOW)).toBe("HIGH");
  });

  it("CONTROL: pending status does not return HIGH on its own, proving the escalated branch is meaningful", () => {
    expect(approvalPriority(null, "pending", NOW)).toBe("NORMAL");
  });
});

describe("approvalPriority — overdue (dueAt in the past)", () => {
  it("BITE: non-null dueAt strictly in the past returns HIGH", () => {
    expect(approvalPriority(PAST, "pending", NOW)).toBe("HIGH");
  });

  it("dueAt as a string ISO value in the past also returns HIGH — adapters may forward ISO strings", () => {
    expect(approvalPriority(PAST.toISOString(), "pending", NOW)).toBe("HIGH");
  });

  it("CONTROL: non-null dueAt in the future returns NORMAL, proving the overdue branch gates on past-ness", () => {
    expect(approvalPriority(FUTURE, "pending", NOW)).toBe("NORMAL");
  });
});

describe("approvalPriority — boundary: dueAt at exactly now", () => {
  it("dueAt equal to now is not yet past and returns NORMAL (boundary: strict less-than, not lte)", () => {
    expect(approvalPriority(NOW, "pending", NOW)).toBe("NORMAL");
  });
});

describe("approvalPriority — null or missing dueAt", () => {
  it("BITE: null dueAt with pending status returns NORMAL", () => {
    expect(approvalPriority(null, "pending", NOW)).toBe("NORMAL");
  });

  it("null dueAt with in_progress status returns NORMAL", () => {
    expect(approvalPriority(null, "in_progress", NOW)).toBe("NORMAL");
  });

  it("CONTROL: null dueAt with escalated status still returns HIGH — status wins", () => {
    expect(approvalPriority(null, "escalated", NOW)).toBe("HIGH");
  });
});

describe("approvalPriority — default now parameter", () => {
  it("calling without a now argument does not throw and returns a valid priority string", () => {
    const result = approvalPriority(null, "pending");
    expect(["HIGH", "NORMAL"]).toContain(result);
  });
});
