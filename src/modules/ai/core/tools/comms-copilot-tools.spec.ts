import { CommsCopilotTools } from "./comms-copilot-tools";
import type { Db } from "../../../../db/drizzle.module";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import * as resolveAttendeesModule from "./lib/resolve-attendees";
import type { AttendeeResolution } from "./lib/resolve-attendees";

jest.mock("./lib/resolve-attendees");

const ORG = "org-comms-1";
const ACTOR_USER = "user-comms-1";

function makeAskOsActor(): AskOsActor {
  return {
    userId: ACTOR_USER,
    orgId: ORG,
    membershipId: 1,
    displayName: "Test User",
    email: "test@example.com",
    orgName: "Test Org",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "America/New_York",
    today: "2026-09-19",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
  };
}

function makeCaller(): CurrentUserContext {
  return {
    userId: ACTOR_USER,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-test",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeCtx(): AskOsToolRunContext {
  return {
    actor: makeAskOsActor(),
    caller: makeCaller(),
    read: ScopedRead.of(ORG, ACTOR_USER, "all"),
    readFor: () => ScopedRead.of(ORG, ACTOR_USER, "all"),
    modules: {},
  };
}

function fakeDb(): Db {
  return {} as Db;
}

function confirmationDouble(): AiConfirmationService {
  return {
    propose: jest.fn().mockResolvedValue({
      proposalId: 5,
      token: "tok-5",
      expiresAt: new Date("2026-09-19T00:02:00.000Z"),
    }),
  } as unknown as AiConfirmationService;
}

function buildTools() {
  const confirmation = confirmationDouble();
  const sut = new CommsCopilotTools(fakeDb(), confirmation);
  return { sut, confirmation };
}

function findTool(defs: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`Tool "${key}" not in tools()`);
  return def;
}

function stubResolution(resolution: AttendeeResolution): void {
  jest.mocked(resolveAttendeesModule.resolveAttendeeNames).mockResolvedValue(resolution);
}

describe("CommsCopilotTools.sendDirectMessage delegates name resolution to the directory seam", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns empty when the recipient name resolves to nobody", async () => {
    stubResolution({ resolved: [], unresolved: ["Raj"], firstAmbiguous: null });
    const { sut, confirmation } = buildTools();

    const result = await findTool(sut.tools(), "sendDirectMessage").run(
      { recipientName: "Raj", message: "hi" },
      makeCtx(),
    );

    expect(result).toMatchObject({ kind: "empty", subject: "recipient" });
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("returns ambiguous when the name matches more than one member", async () => {
    stubResolution({
      resolved: [],
      unresolved: [],
      firstAmbiguous: { needle: "Sam", candidates: [{ label: "Sam A" }, { label: "Sam B" }] },
    });
    const { sut, confirmation } = buildTools();

    const result = await findTool(sut.tools(), "sendDirectMessage").run(
      { recipientName: "Sam", message: "hey" },
      makeCtx(),
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous")
      expect(result.candidates.map((c) => c.label)).toContain("Sam A");
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("proposes a confirmation card rather than sending the message directly", async () => {
    stubResolution({ resolved: ["u1"], unresolved: [], firstAmbiguous: null });
    const { sut, confirmation } = buildTools();

    const result = await findTool(sut.tools(), "sendDirectMessage").run(
      { recipientName: "Jordan Lee", message: "hey" },
      makeCtx(),
    );

    expect(result).toMatchObject({ kind: "needs-confirmation", proposalId: 5, token: "tok-5" });
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "chat.sendDirect", payload: { targetUserId: "u1", message: "hey" } }),
    );
  });

  it("previews the recipient name the user provided, not the raw user id", async () => {
    stubResolution({ resolved: ["u1"], unresolved: [], firstAmbiguous: null });
    const { sut } = buildTools();

    const result = await findTool(sut.tools(), "sendDirectMessage").run(
      { recipientName: "Jordan Lee", message: "hey" },
      makeCtx(),
    );

    expect(result).toMatchObject({ preview: { recipient: "Jordan Lee" } });
  });
});

describe("CommsCopilotTools.scheduleEvent delegates name resolution to the directory seam", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns a confirmation card rather than booking the meeting directly", async () => {
    stubResolution({ resolved: [], unresolved: [], firstAmbiguous: null });
    const { sut, confirmation } = buildTools();

    const result = await findTool(sut.tools(), "scheduleEvent").run(
      {
        title: "Team Sync",
        startDate: "2026-10-01T10:00:00.000Z",
        endDate: "2026-10-01T11:00:00.000Z",
      },
      makeCtx(),
    );

    expect(result).toMatchObject({ kind: "needs-confirmation", action: "calendar.scheduleMeeting" });
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ timezone: "America/New_York" }) }),
    );
  });

  it("returns ambiguous and does not propose when an attendee name matches multiple members", async () => {
    stubResolution({
      resolved: [],
      unresolved: [],
      firstAmbiguous: { needle: "Sam", candidates: [{ label: "Sam A" }, { label: "Sam B" }] },
    });
    const { sut, confirmation } = buildTools();

    const result = await findTool(sut.tools(), "scheduleEvent").run(
      {
        title: "Team Sync",
        startDate: "2026-10-01T10:00:00.000Z",
        endDate: "2026-10-01T11:00:00.000Z",
        attendeeNames: ["Sam"],
      },
      makeCtx(),
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      expect(result.candidates.map((c) => c.label)).toContain("Sam A");
    }
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("notes unresolved names in the summary but still proposes when resolved attendees exist", async () => {
    stubResolution({ resolved: ["u1"], unresolved: ["Nobody"], firstAmbiguous: null });
    const { sut } = buildTools();

    const result = await findTool(sut.tools(), "scheduleEvent").run(
      {
        title: "Team Sync",
        startDate: "2026-10-01T10:00:00.000Z",
        endDate: "2026-10-01T11:00:00.000Z",
        attendeeNames: ["Alice", "Nobody"],
      },
      makeCtx(),
    );

    expect(result).toMatchObject({ kind: "needs-confirmation" });
    if (result.kind === "needs-confirmation")
      expect(result.summary).toContain("Could not match");
  });

  it("takes the timezone from the actor already on the turn context rather than reading it back from the database", async () => {
    stubResolution({ resolved: [], unresolved: [], firstAmbiguous: null });
    const { sut, confirmation } = buildTools();

    await findTool(sut.tools(), "scheduleEvent").run(
      {
        title: "Standup",
        startDate: "2026-10-01T14:00:00.000Z",
        endDate: "2026-10-01T14:30:00.000Z",
      },
      makeCtx(),
    );

    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ timezone: "America/New_York" }),
      }),
    );
  });
});
