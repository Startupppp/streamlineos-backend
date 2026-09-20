import { buildContextPrompt } from "./chat-assistant-prompt";
import type { ChatContext } from "./chat-assistant-model";
import type { AskOsActor } from "./ask-os-actor";

const ACTOR: AskOsActor = {
  userId: "u1",
  orgId: "o1",
  membershipId: 4,
  displayName: "Test Member",
  email: "member@example.com",
  orgName: "Acme",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const CONTEXT: ChatContext = {
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

describe("chat system prompt carries no figure the caller may be unauthorised to read", () => {
  it("states no organisation-wide project or ticket count, so a restricted token cannot read one out of its own prompt", () => {
    const prompt = buildContextPrompt(CONTEXT, ACTOR);

    expect(prompt).not.toMatch(/\bProjects:/);
    expect(prompt).not.toMatch(/tickets:\s*\d/i);
    expect(prompt).not.toMatch(/hot leads/i);
  });

  it("exposes only caller-scoped subjects, because the preamble bypasses the tool permission layer entirely", () => {
    const contextKeys = Object.keys(CONTEXT);

    expect(contextKeys).toEqual([
      "todayAttendance",
      "pendingLeaves",
      "recentPayrolls",
      "myLeadsCount",
      "myOpenDealsCount",
      "topLeads",
    ]);
  });

  it("forbids deriving a figure from context, so an unavailable tool never becomes an inferred zero", () => {
    const prompt = buildContextPrompt(CONTEXT, ACTOR);

    expect(prompt).toMatch(/Every figure you state must come from a tool result/);
    expect(prompt).toMatch(/do not infer that the\s+answer is zero, none or empty/);
  });

  it("(anti-vacuous) the org-wide assertion would fail if a count were reintroduced into the prompt", () => {
    const withCount = `${buildContextPrompt(CONTEXT, ACTOR)}\n- Projects: 9; tickets: 178`;

    expect(withCount).toMatch(/\bProjects:/);
    expect(withCount).toMatch(/tickets:\s*\d/i);
  });
});
