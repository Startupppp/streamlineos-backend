import type { UIMessageChunk } from "ai";
import {
  buildAskOsDirectiveStream,
  makeAskOsDirectivePipe,
  type ModelStreamSource,
} from "./ai-stream-response";
import { buildContextPrompt } from "../services/chat-assistant-prompt";
import type { AskOsDirective } from "./ask-os-directive";
import type { AskOsActor } from "../services/ask-os-actor";
import type { ChatContext } from "../services/chat-assistant-model";

function makeTextChunks(text: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "t1" });
      controller.enqueue({ type: "text-delta", id: "t1", delta: text });
      controller.enqueue({ type: "text-end", id: "t1" });
      controller.close();
    },
  });
}

function makeModelStream(text: string): ModelStreamSource {
  return {
    toUIMessageStream: () => makeTextChunks(text),
  };
}

async function collectDirectiveChunks(
  modelStream: ModelStreamSource,
  directives: AskOsDirective[],
): Promise<UIMessageChunk[]> {
  const stream = buildAskOsDirectiveStream(modelStream, directives);

  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

const MOCK_ACTOR: AskOsActor = {
  orgId: "org_1",
  userId: "user_1",
  membershipId: 1,
  orgName: "Acme",
  displayName: "Alice",
  email: "alice@acme.com",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const MOCK_CONTEXT: ChatContext = {
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

describe("makeAskOsDirectivePipe emits typed stream parts for Ask OS directives", () => {
  it("a confirmation outcome produces exactly one data-askos-directive part carrying the proposal, marked transient", async () => {
    const confirmDirective: AskOsDirective = {
      kind: "confirm-action",
      proposalId: 42,
      token: "hmac-secret-token-abc123",
      action: "ticket.create",
      summary: "Create ticket: Deploy backend",
      preview: { title: "Deploy backend", type: "TASK" },
    };

    const chunks = await collectDirectiveChunks(makeModelStream("Action ready."), [confirmDirective]);

    const directiveParts = chunks.filter((c) => c.type === "data-askos-directive");
    expect(directiveParts).toHaveLength(1);

    const part = directiveParts[0];
    expect(part).toMatchObject({
      type: "data-askos-directive",
      transient: true,
      data: {
        kind: "confirm-action",
        proposalId: 42,
        token: "hmac-secret-token-abc123",
        action: "ticket.create",
        summary: "Create ticket: Deploy backend",
        preview: { title: "Deploy backend", type: "TASK" },
      },
    });
  });

  it("a connection outcome carries toolkit and reason, distinguishing no-connection from needs-reauth", async () => {
    const noConnectionDirective: AskOsDirective = {
      kind: "connect-integration",
      toolkit: "googlecalendar",
      reason: "no-connection",
      summary: "Connect Google Calendar to schedule events",
    };
    const reauthDirective: AskOsDirective = {
      kind: "connect-integration",
      toolkit: "gmail",
      reason: "needs-reauth",
      summary: "Re-authenticate Gmail to send emails",
    };

    const noConnChunks = await collectDirectiveChunks(makeModelStream("Needs connection."), [noConnectionDirective]);
    const reauthChunks = await collectDirectiveChunks(makeModelStream("Needs reauth."), [reauthDirective]);

    const [noConnPart] = noConnChunks.filter((c) => c.type === "data-askos-directive");
    const [reauthPart] = reauthChunks.filter((c) => c.type === "data-askos-directive");

    expect(noConnPart).toMatchObject({
      type: "data-askos-directive",
      transient: true,
      data: { kind: "connect-integration", toolkit: "googlecalendar", reason: "no-connection" },
    });
    expect(reauthPart).toMatchObject({
      type: "data-askos-directive",
      transient: true,
      data: { kind: "connect-integration", toolkit: "gmail", reason: "needs-reauth" },
    });

    const noConnData = (noConnPart as { data: AskOsDirective }).data;
    const reauthData = (reauthPart as { data: AskOsDirective }).data;
    expect(noConnData.kind).toBe("connect-integration");
    expect(reauthData.kind).toBe("connect-integration");
    if (noConnData.kind === "connect-integration") expect(noConnData.reason).toBe("no-connection");
    if (reauthData.kind === "connect-integration") expect(reauthData.reason).toBe("needs-reauth");
  });

  it("the HMAC token never appears in the assistant text output when a confirmation directive is present", async () => {
    const secretToken = "super-secret-hmac-token-xyz789";
    const confirmDirective: AskOsDirective = {
      kind: "confirm-action",
      proposalId: 1,
      token: secretToken,
      action: "ticket.create",
      summary: "Create a ticket",
      preview: {},
    };
    const modelText = "Action ready for confirmation.";

    const chunks = await collectDirectiveChunks(makeModelStream(modelText), [confirmDirective]);

    const textDeltas = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");

    expect(textDeltas).not.toContain(secretToken);
    expect(textDeltas).toBe(modelText);
  });

  it("the prompt no longer contains CONFIRM_ACTION: or CONNECT_INTEGRATION: sentinel instructions", () => {
    const prompt = buildContextPrompt(MOCK_CONTEXT, MOCK_ACTOR);

    expect(prompt).not.toContain("CONFIRM_ACTION:");
    expect(prompt).not.toContain("CONNECT_INTEGRATION:");
  });

  it("an ordinary turn with no directives streams text normally without any data-askos-directive parts", async () => {
    const expectedText = "Here is your answer.";

    const chunks = await collectDirectiveChunks(makeModelStream(expectedText), []);

    const directiveParts = chunks.filter((c) => c.type === "data-askos-directive");
    const textDeltas = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");

    expect(directiveParts).toHaveLength(0);
    expect(textDeltas).toBe(expectedText);
  });

  it("makeAskOsDirectivePipe returns a PipeableAiUiStream with pipeUIMessageStreamToResponse", () => {
    const pipe = makeAskOsDirectivePipe(makeModelStream("hello"), []);
    expect(typeof pipe.pipeUIMessageStreamToResponse).toBe("function");
  });
});

describe("a directive reaches the client before the stream ends, so the card has a frame to render in", () => {
  function streamPushingDirectiveMidway(
    directives: AskOsDirective[],
    directive: AskOsDirective,
  ): ModelStreamSource {
    return {
      toUIMessageStream: () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "Scheduling" });
            directives.push(directive);
            controller.enqueue({ type: "text-delta", id: "t1", delta: " the reminder." });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.close();
          },
        }),
    };
  }

  const reminderDirective: AskOsDirective = {
    kind: "confirm-action",
    proposalId: 7,
    token: "7.1700000000.abc",
    action: "calendar.createReminder",
    summary: "Create reminder: Reminder for STRE-42",
    preview: { title: "Reminder for STRE-42" },
  };

  it("emits the directive once the tool has resolved rather than holding it until after the last chunk", async () => {
    const directives: AskOsDirective[] = [];

    const chunks = await collectDirectiveChunks(
      streamPushingDirectiveMidway(directives, reminderDirective),
      directives,
    );

    const directiveIndex = chunks.findIndex((c) => c.type === "data-askos-directive");
    const textEndIndex = chunks.findIndex((c) => c.type === "text-end");

    expect(directiveIndex).toBeGreaterThanOrEqual(0);
    expect(directiveIndex).toBeLessThan(textEndIndex);
  });

  it("still emits a directive pushed after the final chunk, so nothing is dropped on the last step", async () => {
    const directives: AskOsDirective[] = [reminderDirective];

    const chunks = await collectDirectiveChunks(makeModelStream("done"), directives);

    expect(chunks.filter((c) => c.type === "data-askos-directive")).toHaveLength(1);
  });

  it("emits each directive exactly once even though the flush runs after every chunk", async () => {
    const directives: AskOsDirective[] = [];

    const chunks = await collectDirectiveChunks(
      streamPushingDirectiveMidway(directives, reminderDirective),
      directives,
    );

    expect(chunks.filter((c) => c.type === "data-askos-directive")).toHaveLength(1);
  });
});
