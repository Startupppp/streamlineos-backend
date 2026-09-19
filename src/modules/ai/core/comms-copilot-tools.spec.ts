import { CommsCopilotTools } from "./comms-copilot-tools";
import type { Db } from "../../../db/drizzle.module";
import type { AskOsActor } from "./services/ask-os-actor";
import type { AskOsToolRunContext, AskOsToolDefinition } from "./registry/ask-os-tool.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CalendarService } from "../../calendar/calendar.service";
import type { ChatChannelsService } from "../../chat/chat-channels.service";
import type { ChatMessagesService } from "../../chat/chat-messages.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-comms-1";
const ACTOR_USER = "user-comms-1";

type MemberRow = { id: string; firstName: string | null; lastName: string | null; name: string | null };

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
    scope: "all",
    scopes: {},
    modules: {},
  };
}

interface MemberQueryChain {
  from: (...args: unknown[]) => MemberQueryChain;
  innerJoin: (...args: unknown[]) => MemberQueryChain;
  where: (...args: unknown[]) => Promise<MemberRow[]>;
  orderBy: (...args: unknown[]) => MemberQueryChain;
  limit: (...args: unknown[]) => Promise<MemberRow[]>;
}

function membersDb(members: MemberRow[]): Db {
  const chain: MemberQueryChain = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    where: jest.fn(() => Promise.resolve(members)),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(members)),
  };
  return { select: jest.fn(() => chain) } as unknown as Db;
}

function noopCalendar(): CalendarService {
  return {
    createEvent: jest.fn().mockResolvedValue({ event: { id: "evt-1" } }),
  } as unknown as CalendarService;
}

function noopChatChannels(): ChatChannelsService {
  return {
    createChannel: jest.fn().mockResolvedValue({ channel: { id: "ch-1" } }),
  } as unknown as ChatChannelsService;
}

function noopChatMessages(): ChatMessagesService {
  return {
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as ChatMessagesService;
}

function findTool(defs: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`Tool "${key}" not in tools()`);
  return def;
}

describe("CommsCopilotTools — ambiguity and resolution handling", () => {
  describe("sendDirectMessage", () => {
    it("returns empty when the recipient name matches no org member", async () => {
      const db = membersDb([]);
      const sut = new CommsCopilotTools(db, noopCalendar(), noopChatChannels(), noopChatMessages());
      const def = findTool(sut.tools(), "sendDirectMessage");

      const result = await def.run({ recipientName: "nobody", message: "hi" }, makeCtx());

      expect(result).toMatchObject({ kind: "empty", subject: "recipient" });
    });

    it("returns failed when the recipient name matches multiple org members", async () => {
      const db = membersDb([
        { id: "u1", firstName: "Alex", lastName: "Smith", name: null },
        { id: "u2", firstName: "Alex", lastName: "Jones", name: null },
      ]);
      const sut = new CommsCopilotTools(db, noopCalendar(), noopChatChannels(), noopChatMessages());
      const def = findTool(sut.tools(), "sendDirectMessage");

      const result = await def.run({ recipientName: "alex", message: "hi" }, makeCtx());

      expect(result).toMatchObject({ kind: "failed" });
      expect((result as { kind: "failed"; reason: string }).reason).toContain("alex");
    });

    it("returns data and sends the message when the recipient is matched exactly once", async () => {
      const db = membersDb([{ id: "u1", firstName: "Jordan", lastName: "Lee", name: null }]);
      const channels = noopChatChannels();
      const messages = noopChatMessages();
      const sut = new CommsCopilotTools(db, noopCalendar(), channels, messages);
      const def = findTool(sut.tools(), "sendDirectMessage");

      const result = await def.run({ recipientName: "jordan", message: "hey" }, makeCtx());

      expect(channels.createChannel).toHaveBeenCalled();
      expect(messages.send).toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "data" });
    });
  });

  describe("scheduleEvent", () => {
    it("returns failed when any attendee name matches multiple members", async () => {
      const db = membersDb([
        { id: "u1", firstName: "Sam", lastName: "A", name: null },
        { id: "u2", firstName: "Sam", lastName: "B", name: null },
      ]);
      const sut = new CommsCopilotTools(db, noopCalendar(), noopChatChannels(), noopChatMessages());
      const def = findTool(sut.tools(), "scheduleEvent");

      const result = await def.run(
        {
          title: "Team Sync",
          startDate: "2026-10-01T10:00:00.000Z",
          endDate: "2026-10-01T11:00:00.000Z",
          attendeeNames: ["sam"],
        },
        makeCtx(),
      );

      expect(result).toMatchObject({ kind: "failed" });
    });

    it("creates the event and returns data even when some attendee names cannot be resolved", async () => {
      const db = membersDb([]);
      const calendar = noopCalendar();
      const sut = new CommsCopilotTools(db, calendar, noopChatChannels(), noopChatMessages());
      const def = findTool(sut.tools(), "scheduleEvent");

      const result = await def.run(
        {
          title: "Team Sync",
          startDate: "2026-10-01T10:00:00.000Z",
          endDate: "2026-10-01T11:00:00.000Z",
          attendeeNames: ["nobody"],
        },
        makeCtx(),
      );

      expect(calendar.createEvent).toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "data" });
    });

    it("uses the actor timezone from context rather than an extra database query", async () => {
      const db = membersDb([]);
      const calendar = noopCalendar();
      const sut = new CommsCopilotTools(db, calendar, noopChatChannels(), noopChatMessages());
      const def = findTool(sut.tools(), "scheduleEvent");

      await def.run(
        { title: "Standup", startDate: "2026-10-01T14:00:00.000Z", endDate: "2026-10-01T14:30:00.000Z" },
        makeCtx(),
      );

      expect(calendar.createEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ timezone: "America/New_York" }),
      );
    });
  });
});
