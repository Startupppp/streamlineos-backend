import Ably from "ably";
import postgres from "postgres";
import { mint, req, check, report, ORG, BASE_URL } from "./harness.mjs";

const owner = await mint("owner");
const sales = await mint({ sub: "fb0c586a-399a-45fa-bffc-894bcf4430f6", role: "SALES_REP", isOrgOwner: true });
const OWNER_ID = "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb";
const SALES_ID = "fb0c586a-399a-45fa-bffc-894bcf4430f6";

const dbUrl = (process.env.DATABASE_URL ?? "").replace(/^['"]|['"]$/g, "");
const sqlDb = postgres(dbUrl, {
  max: 1,
  ssl: dbUrl.includes("neon.tech") || dbUrl.includes("sslmode=require") ? "require" : undefined,
});

const rows = await sqlDb`
  select id, name from chat_channels
  where org_id = ${ORG} and is_archived = false and type <> 'DIRECT'
  order by id asc limit 1`;
const channelRow = rows[0];
if (!channelRow) {
  console.error("No channel exists in the probe org — cannot probe");
  await sqlDb.end();
  report("huddle-realtime");
  process.exit(1);
}
const channelId = channelRow.id;
for (const uid of [OWNER_ID, SALES_ID]) {
  await sqlDb`
    insert into chat_channel_members (channel_id, user_id, role)
    values (${channelId}, ${uid}, 'MEMBER')
    on conflict (channel_id, user_id) do nothing`;
}
await sqlDb.end();
console.log(`Using channel ${channelId} (${channelRow.name})`);

function unwrapEnvelope(payload) {
  if (payload !== null && typeof payload === "object" && "success" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}

const tokenRes = await req("GET", "/chat/ably-token", { token: sales });
check("sales GET /chat/ably-token -> 200", tokenRes, 200);
const tokenRequest = unwrapEnvelope(tokenRes.body);
const capability = JSON.parse(tokenRequest?.capability ?? "{}");
check(
  "ably token capability includes huddle channels",
  { status: capability[`huddle:${ORG}:*`] && capability[`huddle-signal:${ORG}:*`] ? 200 : 0 },
  200,
);

function connectRealtime(bearer) {
  return new Ably.Realtime({
    authCallback: (params, cb) => {
      fetch(`${BASE_URL}/chat/ably-token`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
        .then((r) => r.json())
        .then((tr) => cb(null, unwrapEnvelope(tr)))
        .catch((e) => cb(e, null));
    },
  });
}

function waitForEvent(channel, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      channel.unsubscribe(event, handler);
      resolve(null);
    }, ms);
    const handler = (msg) => {
      clearTimeout(timer);
      channel.unsubscribe(event, handler);
      resolve(msg.data);
    };
    channel.subscribe(event, handler);
  });
}

const salesRt = connectRealtime(sales);
salesRt.connection.on((stateChange) => {
  console.log(`[ably] ${stateChange.previous} -> ${stateChange.current}${stateChange.reason ? ` (${stateChange.reason.message})` : ""}`);
});
const connectResult = await Promise.race([
  salesRt.connection.whenState("connected").then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
]);
check("sales Ably realtime connected", { status: connectResult ? 200 : 0 }, 200);
if (!connectResult) {
  salesRt.close();
  report("huddle-realtime");
  process.exit(1);
}

const salesHuddleCh = salesRt.channels.get(`huddle:${ORG}:${channelId}`);
const salesSignalCh = salesRt.channels.get(`huddle-signal:${ORG}:${channelId}:${SALES_ID}`);
const salesChatCh = salesRt.channels.get(`chat:${ORG}:${channelId}`);
await salesHuddleCh.attach();
await salesSignalCh.attach();
await salesChatCh.attach();

const startedPromise = waitForEvent(salesHuddleCh, "huddle:started", 8000);
const startRes = await req("POST", `/chat/channels/${channelId}/huddle/start`, { token: owner });
check("owner POST huddle/start -> 201", startRes, 201);
const huddleId = unwrapEnvelope(startRes.body)?.id;
const startedEvt = await startedPromise;
check("sales received huddle:started", { status: startedEvt ? 200 : 0 }, 200);

const joinedPromise = waitForEvent(salesHuddleCh, "huddle:user_joined", 8000);
check("sales POST huddles/join -> 200", await req("POST", `/chat/huddles/${huddleId}/join`, { token: sales }), 200);
const joinedEvt = await joinedPromise;
check("sales received huddle:user_joined", { status: joinedEvt?.userId === SALES_ID ? 200 : 0 }, 200);

check("owner PATCH huddles/heartbeat -> 200", await req("PATCH", `/chat/huddles/${huddleId}/heartbeat`, { token: owner }), 200);
check("sales PATCH huddles/heartbeat -> 200", await req("PATCH", `/chat/huddles/${huddleId}/heartbeat`, { token: sales }), 200);

const signalPromise = waitForEvent(salesSignalCh, "signal", 8000);
const signalRes = await req("POST", `/chat/huddles/${huddleId}/signal`, {
  token: owner,
  body: { type: "offer", targetUserId: SALES_ID, payload: { sdp: "probe-sdp", fromUserId: OWNER_ID } },
});
check("owner POST huddles/signal -> 200", signalRes, 200);
const signalEvt = await signalPromise;
check(
  "sales received WebRTC signal (offer, correct sdp)",
  { status: signalEvt?.type === "offer" && signalEvt?.payload?.sdp === "probe-sdp" ? 200 : 0 },
  200,
);

const msgPromise = waitForEvent(salesChatCh, "message", 8000);
const sendRes = await req("POST", `/chat/channels/${channelId}/messages`, {
  token: owner,
  body: { content: `realtime probe ${Date.now()}` },
});
check("owner POST message -> 200/201", sendRes, [200, 201]);
const messageId = unwrapEnvelope(sendRes.body)?.id;
const msgEvt = await msgPromise;
check("sales received realtime message", { status: msgEvt?.id === messageId ? 200 : 0 }, 200);
check(
  "realtime message payload carries senderImage + attachments fields",
  { status: msgEvt && "senderImage" in msgEvt && Array.isArray(msgEvt.attachments) ? 200 : 0 },
  200,
);

const editPromise = waitForEvent(salesChatCh, "message:updated", 8000);
check(
  "owner PATCH message -> 200",
  await req("PATCH", `/chat/channels/${channelId}/messages/${messageId}`, {
    token: owner,
    body: { content: "edited by probe" },
  }),
  200,
);
const editEvt = await editPromise;
check(
  "sales received message:updated",
  { status: editEvt?.id === messageId && editEvt?.content === "edited by probe" ? 200 : 0 },
  200,
);

const reactPromise = waitForEvent(salesChatCh, "reaction:updated", 8000);
check(
  "owner POST reaction -> 200/201",
  await req("POST", `/chat/channels/${channelId}/messages/${messageId}/reactions`, {
    token: owner,
    body: { emoji: "👍" },
  }),
  [200, 201],
);
const reactEvt = await reactPromise;
check("sales received reaction:updated", { status: reactEvt?.messageId === messageId ? 200 : 0 }, 200);

const delPromise = waitForEvent(salesChatCh, "message:deleted", 8000);
check(
  "owner DELETE message -> 200",
  await req("DELETE", `/chat/channels/${channelId}/messages/${messageId}`, { token: owner }),
  200,
);
const delEvt = await delPromise;
check("sales received message:deleted", { status: delEvt?.id === messageId ? 200 : 0 }, 200);

const endedPromise = waitForEvent(salesHuddleCh, "huddle:ended", 8000);
check("sales POST huddles/leave -> 200", await req("POST", `/chat/huddles/${huddleId}/leave`, { token: sales }), 200);
check("owner POST huddles/leave -> 200", await req("POST", `/chat/huddles/${huddleId}/leave`, { token: owner }), 200);
const endedEvt = await endedPromise;
check("sales received huddle:ended", { status: endedEvt ? 200 : 0 }, 200);

const activeAfter = await req("GET", `/chat/channels/${channelId}/huddle`, { token: owner });
check("GET active huddle after end -> 200 null", { status: activeAfter.status === 200 && unwrapEnvelope(activeAfter.body) === null ? 200 : 0 }, 200);

salesRt.close();
const ok = report("huddle-realtime");
process.exit(ok ? 0 : 1);
