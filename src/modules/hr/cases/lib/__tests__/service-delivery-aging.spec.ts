import { classifyAging, sortByUrgency, severityRank } from "../../service-delivery-aging";

describe("service delivery aging", () => {
  const now = new Date("2026-07-24T12:00:00Z");

  it("classifies fresh under 24h", () => {
    const r = classifyAging("2026-07-24T06:00:00Z", now);
    expect(r.bucket).toBe("fresh");
    expect(r.slaBreached).toBe(false);
  });

  it("marks sla breached when past due", () => {
    const r = classifyAging("2026-07-20T12:00:00Z", now, "2026-07-23T12:00:00Z");
    expect(r.slaBreached).toBe(true);
    expect(["overdue", "critical"]).toContain(r.bucket);
  });

  it("sorts critical before fresh", () => {
    const items = sortByUrgency([
      {
        id: 1,
        aging: classifyAging("2026-07-24T10:00:00Z", now),
        severityRank: 1,
      },
      {
        id: 2,
        aging: classifyAging("2026-07-10T12:00:00Z", now),
        severityRank: 2,
      },
    ]);
    expect(items[0]?.id).toBe(2);
  });

  it("ranks severity", () => {
    expect(severityRank("case", "critical")).toBe(4);
    expect(severityRank("helpdesk", "URGENT")).toBe(4);
    expect(severityRank("case", "low")).toBe(1);
  });
});
