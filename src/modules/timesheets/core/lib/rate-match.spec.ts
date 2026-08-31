import { pickBestRate, type RateCandidate } from "./rate-match";

type TestRate = RateCandidate & { billRate: string; currency: string };

function rate(partial: Partial<TestRate> & { id: number }): TestRate {
  return {
    projectId: null,
    userMembershipId: null,
    taskId: null,
    clientId: null,
    priority: 0,
    billRate: "100",
    currency: "USD",
    ...partial,
  };
}

describe("pickBestRate", () => {
  it("returns null when there are no rates", () => {
    expect(pickBestRate<TestRate>([], { projectId: 1 })).toBeNull();
  });

  it("returns null when nothing matches the query", () => {
    const r = rate({ id: 1, projectId: 99 });
    expect(pickBestRate([r], { projectId: 1 })).toBeNull();
  });

  it("an all-null (org default) rate matches any query", () => {
    const r = rate({ id: 1 });
    expect(pickBestRate([r], { projectId: 5, userMembershipId: 1 })).toBe(r);
  });

  it("the more specific match wins over a broader one", () => {
    const generic = rate({ id: 1, userMembershipId: 1 });
    const specific = rate({ id: 2, projectId: 5, userMembershipId: 1 });
    expect(pickBestRate([generic, specific], { projectId: 5, userMembershipId: 1 })).toBe(specific);
  });

  it("priority breaks ties at equal specificity", () => {
    const low = rate({ id: 1, projectId: 5, priority: 1 });
    const high = rate({ id: 2, projectId: 5, priority: 9 });
    expect(pickBestRate([low, high], { projectId: 5 })).toBe(high);
  });

  it("the newer rate (higher id) breaks ties at equal specificity and priority", () => {
    const older = rate({ id: 1, projectId: 5 });
    const newer = rate({ id: 2, projectId: 5 });
    expect(pickBestRate([older, newer], { projectId: 5 })).toBe(newer);
  });

  it("a task rate resolves against the query ticketId", () => {
    const r = rate({ id: 1, taskId: 7 });
    expect(pickBestRate([r], { ticketId: 7 })).toBe(r);
    expect(pickBestRate([r], { ticketId: 8 })).toBeNull();
  });
});
