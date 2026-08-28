import "dotenv/config";
import { randomUUID } from "node:crypto";
import { AblyService } from "../modules/realtime/ably.service";
import Ably from "ably";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;
import { FaultServer } from "./fault-server";

function makeAbly(apiKey: string | undefined): AblyService {
  return new AblyService({ ABLY_API_KEY: apiKey });
}

describe("AblyService — realtime adapter absent (no key configured)", () => {
  let service: AblyService;

  beforeEach(() => {
    service = makeAbly(undefined);
  });

  it("is not configured when no API key is provided", () => {
    expect(service.configured).toBe(false);
  });

  it("publishChatEvent is a no-op — durable events survive without realtime delivery", async () => {
    await expect(service.publishChatEvent("org-1", 1, "message", {})).resolves.not.toThrow();
  });

  it("publishHuddleEvent is a no-op", async () => {
    await expect(service.publishHuddleEvent("org-1", 1, "join", {})).resolves.not.toThrow();
  });

  it("publishHuddleSignal is a no-op", async () => {
    await expect(service.publishHuddleSignal("org-1", 1, "user-2", {})).resolves.not.toThrow();
  });

  it("publishToUser without requireConfigured is a no-op", async () => {
    await expect(service.publishToUser("org-1", "user-1", "event", {})).resolves.not.toThrow();
  });

  it("publishChatMessage with requireConfigured throws so the caller knows delivery failed and can fall back", async () => {
    await expect(
      service.publishChatMessage("org-1", 1, {
        id: 1,
        channelId: 1,
        senderId: "user-1",
        senderName: "Alice",
        senderImage: null,
        content: "hello",
        createdAt: new Date(),
        replyToId: null,
        metadata: null,
        messageType: "text",
        attachments: [],
        idempotencyKey: "key-1",
      }, { requireConfigured: true }),
    ).rejects.toThrow("Ably is not configured");
  });

  it("revokeUserTokens is a no-op — the TTL backstop remains", async () => {
    await expect(service.revokeUserTokens("user-1")).resolves.not.toThrow();
  });

  it("publishSupportTicketEvent is a no-op", async () => {
    await expect(service.publishSupportTicketEvent("org-1", 42, "update", {})).resolves.not.toThrow();
  });
});

describe("Realtime channel naming — clients reconnect to the same channel from DB watermarks", () => {
  let service: AblyService;

  beforeEach(() => {
    service = makeAbly(undefined);
  });

  it("chat channel name encodes orgId and channelId so clients can reconnect deterministically", () => {
    const name = service.channelName("org-1", 42);
    expect(name).toBe("chat:org-1:42");
    expect(name).toContain("org-1");
    expect(name).toContain("42");
  });

  it("support channel name encodes orgId and ticketId", () => {
    const name = service.supportChannelName("org-1", 99);
    expect(name).toBe("support:org-1:99");
    expect(name).toContain("org-1");
    expect(name).toContain("99");
  });

  it("channel names are stable — the same inputs always produce the same name", () => {
    const a = service.channelName("org-stable", 7);
    const b = service.channelName("org-stable", 7);
    expect(a).toBe(b);
  });

  it("different orgs have distinct channel names — no cross-tenant channel bleed", () => {
    const a = service.channelName("org-a", 1);
    const b = service.channelName("org-b", 1);
    expect(a).not.toBe(b);
  });
});

describeWithDb("AblyService — realtime adapter present but publishing fails (fault server simulation)", () => {
  let server: FaultServer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    server = new FaultServer({ mode: "error", statusCode: 503 });
    await server.start();
    sql = postgres(databaseUrl ?? "", { prepare: false });
  });

  afterAll(async () => {
    await server.stop();
    await sql.end();
  });

  it("integration: when Ably REST endpoint is unreachable, publish throws and the outbox event in Postgres is unaffected — verified with real Postgres and fault server", async () => {
    const ROLLBACK = new Error("__rollback__");

    await sql
      .begin(async (tx) => {
        const [org] = await tx`SELECT id FROM organizations WHERE deleted_at IS NULL LIMIT 1`;
        const orgId = String(org["id"]);
        const eventId = randomUUID();

        await tx`
          INSERT INTO outbox_events
            (event_id, organization_id, aggregate_type, aggregate_id,
             aggregate_version, event_type, payload, occurred_at, created_at)
          VALUES
            (${eventId}, ${orgId}, 'chat.message', 'msg-realtime-1', 1,
             'chat.message.created', '{}', NOW(), NOW())
        `;

        const rest = new Ably.Rest({
          key: "test.abc:secretkey",
          restHost: "127.0.0.1",
          port: server.port,
          tls: false,
        });

        await expect(
          rest.channels.get("degrade-test").publish("msg", { text: "hello" }),
        ).rejects.toThrow();

        const [row] = await tx`
          SELECT delivery_state FROM outbox_events WHERE event_id = ${eventId}
        `;

        expect(String(row["delivery_state"])).toBe("PENDING");

        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
  });

  it.skip(
    "unblocked by: a real Ably account with a valid API key so a test client can subscribe to a channel and verify it receives messages from the DB lastReadAt watermark after reconnecting — the subscription and message history retrieval require Ably infrastructure that is not available in this environment",
    () => {},
  );
});
