import {
  displayNameFrom,
  zonedCalendarFacts,
  FALLBACK_TIMEZONE,
} from "./ask-os-actor";
import { buildContextPrompt } from "./chat-assistant-prompt";
import type { AskOsActor } from "./ask-os-actor";
import type { ChatContext } from "./chat-assistant-model";

const EMPTY_CONTEXT: ChatContext = {
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

function actor(overrides: Partial<AskOsActor> = {}): AskOsActor {
  return {
    userId: "user-1",
    orgId: "org-1",
    membershipId: 7,
    displayName: "Aditya Challa",
    email: "aditya@example.com",
    orgName: "Acme",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "Asia/Kolkata",
    today: "2026-09-19",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
    ...overrides,
  };
}

describe("display name never falls back to a raw id when a human name exists", () => {
  it("prefers users.name", () => {
    expect(
      displayNameFrom({ name: "Aditya Challa", firstName: "A", lastName: "C", email: "a@b.c" }),
    ).toBe("Aditya Challa");
  });

  it("composes first and last when name is null, because users.name is nullable", () => {
    expect(
      displayNameFrom({ name: null, firstName: "Aditya", lastName: "Challa", email: "a@b.c" }),
    ).toBe("Aditya Challa");
  });

  it("falls back to email rather than an opaque id", () => {
    expect(
      displayNameFrom({ name: null, firstName: null, lastName: null, email: "a@b.c" }),
    ).toBe("a@b.c");
  });

  it("treats a whitespace-only name as absent", () => {
    expect(
      displayNameFrom({ name: "   ", firstName: "Aditya", lastName: null, email: "a@b.c" }),
    ).toBe("Aditya");
  });
});

describe("month boundaries are computed in the organisation's zone", () => {
  it("gives the real last day for a 30-day month", () => {
    const facts = zonedCalendarFacts("Asia/Kolkata", new Date("2026-09-19T12:00:00Z"));
    expect(facts.monthStart).toBe("2026-09-01");
    expect(facts.monthEnd).toBe("2026-09-30");
    expect(facts.today).toBe("2026-09-19");
  });

  it("gives 31 for a 31-day month and 28 for a non-leap February", () => {
    expect(zonedCalendarFacts("UTC", new Date("2026-01-15T00:00:00Z")).monthEnd).toBe("2026-01-31");
    expect(zonedCalendarFacts("UTC", new Date("2026-02-15T00:00:00Z")).monthEnd).toBe("2026-02-28");
  });

  it("gives 29 for a leap February", () => {
    expect(zonedCalendarFacts("UTC", new Date("2024-02-15T00:00:00Z")).monthEnd).toBe("2024-02-29");
  });

  it("rolls the date forward for a zone already past midnight, so 'today' is the user's today", () => {
    const utc = zonedCalendarFacts("UTC", new Date("2026-09-19T20:00:00Z"));
    const kolkata = zonedCalendarFacts("Asia/Kolkata", new Date("2026-09-19T20:00:00Z"));
    expect(utc.today).toBe("2026-09-19");
    expect(kolkata.today).toBe("2026-09-20");
  });

  it("uses UTC only as an explicit fallback", () => {
    expect(FALLBACK_TIMEZONE).toBe("UTC");
  });
});

describe("the prompt makes the caller's identity unmistakable", () => {
  const prompt = buildContextPrompt(EMPTY_CONTEXT, actor());

  it("names the person being spoken to", () => {
    expect(prompt).toContain("Aditya Challa");
    expect(prompt).toContain("aditya@example.com");
  });

  it("states today's date and the zone, so 'this month' has an anchor", () => {
    expect(prompt).toContain("2026-09-19");
    expect(prompt).toContain("Asia/Kolkata");
    expect(prompt).toContain("2026-09-01");
    expect(prompt).toContain("2026-09-30");
  });

  it("forbids asking the user who they are", () => {
    expect(prompt).toContain("NEVER ask the user who they are");
  });

  it("no longer tells the model to call findPerson before answering about the caller", () => {
    expect(prompt).not.toContain("For a named person's work, call findPerson");
    expect(prompt).toContain("Only call\nfindPerson when the user names a DIFFERENT person");
  });

  it("forbids inventing content a tool reported it could not generate", () => {
    expect(prompt).toContain("never invent the content yourself");
  });

  it("no longer instructs the model to echo a CONFIRM_ACTION sentinel — directives are typed stream parts now", () => {
    expect(prompt).not.toContain("CONFIRM_ACTION:");
    expect(prompt).toContain("pending_confirmation");
  });

  it("no longer instructs the model to echo a CONNECT_INTEGRATION sentinel — directives are typed stream parts now", () => {
    expect(prompt).not.toContain("CONNECT_INTEGRATION:");
    expect(prompt).toContain("connection_required");
  });
});
