import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");
const sales = await mint("salesRep");

const iso = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
const RANGE_START = iso(2026, 0, 1);
const RANGE_END = iso(2026, 11, 31);
const FN = `FN_TEST_${Date.now()}`;

// ───────────────────────────────────────────────────────────────────────────
// AUTH: protected routes with NO token must 401 (skip @Public vapid key)
// ───────────────────────────────────────────────────────────────────────────
check("no-token GET /chat/channels -> 401", await req("GET", "/chat/channels", {}), 401);
check("no-token POST /chat/channels -> 401", await req("POST", "/chat/channels", { body: {} }), 401);
check("no-token GET /chat/channels/1 -> 401", await req("GET", "/chat/channels/1", {}), 401);
check("no-token GET /chat/channels/1/messages -> 401", await req("GET", "/chat/channels/1/messages", {}), 401);
check("no-token POST /chat/presence/heartbeat -> 401", await req("POST", "/chat/presence/heartbeat", {}), 401);
check("no-token GET /chat/users -> 401", await req("GET", "/chat/users", {}), 401);
check("no-token GET /chat/unread -> 401", await req("GET", "/chat/unread", {}), 401);
check("no-token PUT /chat/status -> 401", await req("PUT", "/chat/status", { body: { status: "ONLINE" } }), 401);
check("no-token GET /calendar/events -> 401", await req("GET", `/calendar/events?start=${RANGE_START}&end=${RANGE_END}`, {}), 401);
check("no-token POST /calendar/events -> 401", await req("POST", "/calendar/events", { body: {} }), 401);
check("no-token GET /calendar/export -> 401", await req("GET", "/calendar/export?from=2026-01-01&to=2026-12-31", {}), 401);
check("no-token GET /notifications -> 401", await req("GET", "/notifications", {}), 401);
check("no-token PATCH /notifications/read-all -> 401", await req("PATCH", "/notifications/read-all", {}), 401);
check("no-token DELETE /notifications/clear-all -> 401", await req("DELETE", "/notifications/clear-all", {}), 401);
check("no-token POST /push/subscribe -> 401", await req("POST", "/push/subscribe", { body: {} }), 401);
check("no-token DELETE /push/subscribe -> 401", await req("DELETE", "/push/subscribe?endpoint=https://x.example.com/a", {}), 401);

// @Public route works without a token
check("public GET /push/vapid-public-key (no token) -> 200", await req("GET", "/push/vapid-public-key", {}), 200);

// ───────────────────────────────────────────────────────────────────────────
// CHAT — channels (happy path + discover real ids)
// ───────────────────────────────────────────────────────────────────────────
const chRes = await req("GET", "/chat/channels", { token: owner });
check("owner GET /chat/channels -> 200", chRes, 200);
const channels = Array.isArray(chRes.body) ? chRes.body : [];

// pick a channel the owner is an ADMIN of (for update RBAC), and any channel for membership tests
const ownerId = "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb";
const adminChannel = channels.find(
  (c) => (c.members ?? []).some((m) => m.userId === ownerId && m.role === "ADMIN"),
);
const anyChannel = channels[0];
const channelId = (adminChannel ?? anyChannel)?.id;

// member is in zero channels -> auth-only list returns 200 (not over-gated), empty allowed
check("member GET /chat/channels -> 200 (not over-gated)", await req("GET", "/chat/channels", { token: member }), 200);

if (channelId != null) {
  check(`owner GET /chat/channels/${channelId} -> 200`, await req("GET", `/chat/channels/${channelId}`, { token: owner }), 200);
  check(`owner GET /chat/channels/${channelId}/members -> 200`, await req("GET", `/chat/channels/${channelId}/members`, { token: owner }), 200);
  check(`owner POST /chat/channels/${channelId}/read -> 200`, await req("POST", `/chat/channels/${channelId}/read`, { token: owner }), 200);
  check(`owner POST /chat/channels/${channelId}/typing -> 200`, await req("POST", `/chat/channels/${channelId}/typing`, { token: owner }), 200);
  check(`owner GET /chat/channels/${channelId}/typing -> 200`, await req("GET", `/chat/channels/${channelId}/typing`, { token: owner }), 200);

  // RBAC negative: member is NOT a member of this channel -> 403 (service-level membership gate)
  check(`member GET /chat/channels/${channelId} -> 403 (non-member)`, await req("GET", `/chat/channels/${channelId}`, { token: member }), 403);
  check(`member GET /chat/channels/${channelId}/members -> 403 (non-member)`, await req("GET", `/chat/channels/${channelId}/members`, { token: member }), 403);
}

// PATCH update: owner-admin allowed (empty patch = no real mutation), low-priv -> 403
if (adminChannel) {
  check(`owner PATCH /chat/channels/${adminChannel.id} (admin) -> 200`, await req("PATCH", `/chat/channels/${adminChannel.id}`, { token: owner, body: {} }), 200);
  check(`member PATCH /chat/channels/${adminChannel.id} -> 403 (non-member)`, await req("PATCH", `/chat/channels/${adminChannel.id}`, { token: member, body: { name: `${FN}_x` } }), 403);
  // sales is a non-admin member of the demo GROUP channel -> 403 (admins only)
  check(`sales PATCH /chat/channels/${adminChannel.id} -> 403 (non-admin/non-member)`, await req("PATCH", `/chat/channels/${adminChannel.id}`, { token: sales, body: { name: `${FN}_y` } }), 403);
}

// ERROR PATHS — channel detail
// non-existent channel is membership-gated first -> 403 (not 404; backend avoids leaking existence)
check("owner GET /chat/channels/999999 -> 403 (membership-gated)", await req("GET", "/chat/channels/999999", { token: owner }), 403);
// non-numeric id -> ParseIntPipe 400
check("owner GET /chat/channels/abc -> 400 (ParseIntPipe)", await req("GET", "/chat/channels/abc", { token: owner }), 400);
// malformed create body (GROUP missing name/memberIds) -> 400 (does not persist)
check("owner POST /chat/channels malformed -> 400", await req("POST", "/chat/channels", { token: owner, body: { type: "GROUP" } }), 400);

// ───────────────────────────────────────────────────────────────────────────
// CHAT — messages (full write lifecycle on a real channel owner belongs to)
// ───────────────────────────────────────────────────────────────────────────
if (channelId != null) {
  check(`owner GET /chat/channels/${channelId}/messages -> 200`, await req("GET", `/chat/channels/${channelId}/messages`, { token: owner }), 200);
  check(`owner GET /chat/channels/${channelId}/messages/poll?since -> 200`, await req("GET", `/chat/channels/${channelId}/messages/poll?since=${encodeURIComponent(RANGE_START)}`, { token: owner }), 200);
  check(`owner GET /chat/channels/${channelId}/messages/poll (no since) -> 400`, await req("GET", `/chat/channels/${channelId}/messages/poll`, { token: owner }), 400);

  // RBAC negative: non-member cannot read/send
  check(`member GET /chat/channels/${channelId}/messages -> 403 (non-member)`, await req("GET", `/chat/channels/${channelId}/messages`, { token: member }), 403);
  check(`member POST /chat/channels/${channelId}/messages -> 403 (non-member)`, await req("POST", `/chat/channels/${channelId}/messages`, { token: member, body: { content: `${FN}_blocked` } }), 403);

  // ERROR: member of channel sending empty body -> 400 (no content/attachments), does not persist
  check(`owner POST /chat/channels/${channelId}/messages empty -> 400`, await req("POST", `/chat/channels/${channelId}/messages`, { token: owner, body: {} }), 400);

  // WRITE lifecycle: send FN_TEST message -> verify in list -> react -> edit -> soft-delete
  const sendRes = await req("POST", `/chat/channels/${channelId}/messages`, { token: owner, body: { content: `${FN}_message` } });
  check(`owner POST /chat/channels/${channelId}/messages -> 201`, sendRes, 201);
  const msgId = sendRes.body?.id;

  if (msgId != null) {
    const listAfter = await req("GET", `/chat/channels/${channelId}/messages`, { token: owner });
    const found = (listAfter.body?.messages ?? []).some((m) => m.id === msgId);
    check(`sent message ${msgId} present in list`, { status: found ? 200 : 404 }, 200);

    // react (toggle on) and again (toggle off) -> 200
    check(`owner react msg ${msgId} -> 200`, await req("POST", `/chat/channels/${channelId}/messages/${msgId}/reactions`, { token: owner, body: { emoji: "👍" } }), 200);
    check(`owner un-react msg ${msgId} -> 200`, await req("POST", `/chat/channels/${channelId}/messages/${msgId}/reactions`, { token: owner, body: { emoji: "👍" } }), 200);

    // edit own message -> 200
    check(`owner PATCH msg ${msgId} -> 200`, await req("PATCH", `/chat/channels/${channelId}/messages/${msgId}`, { token: owner, body: { content: `${FN}_edited` } }), 200);

    // clean up: soft-delete the test message
    check(`owner DELETE msg ${msgId} -> 200`, await req("DELETE", `/chat/channels/${channelId}/messages/${msgId}`, { token: owner }), 200);
  }

  // react to a non-existent message (owner is a member) -> 404
  check(`owner react non-existent msg -> 404`, await req("POST", `/chat/channels/${channelId}/messages/999999/reactions`, { token: owner, body: { emoji: "👍" } }), 404);
  // malformed reaction body (empty emoji) -> 400
  check(`owner react malformed -> 400`, await req("POST", `/chat/channels/${channelId}/messages/1/reactions`, { token: owner, body: { emoji: "" } }), 400);
}

// ───────────────────────────────────────────────────────────────────────────
// CHAT — presence / search / users
// ───────────────────────────────────────────────────────────────────────────
check("owner POST /chat/presence/heartbeat -> 200", await req("POST", "/chat/presence/heartbeat", { token: owner }), 200);
check("owner GET /chat/presence/online -> 200", await req("GET", "/chat/presence/online", { token: owner }), 200);
check("owner PUT /chat/status (valid) -> 200", await req("PUT", "/chat/status", { token: owner, body: { status: "ONLINE" } }), 200);
check("owner PUT /chat/status (malformed) -> 400", await req("PUT", "/chat/status", { token: owner, body: { status: "BOGUS" } }), 400);
check("owner GET /chat/unread -> 200", await req("GET", "/chat/unread", { token: owner }), 200);
check("owner GET /chat/search?query=ab -> 200", await req("GET", "/chat/search?query=ab", { token: owner }), 200);
check("owner GET /chat/search?query=a (too short) -> 400", await req("GET", "/chat/search?query=a", { token: owner }), 400);
check("owner GET /chat/users -> 200", await req("GET", "/chat/users", { token: owner }), 200);
// auth-only routes: a plain member must not be over-gated
check("member GET /chat/users -> 200 (not over-gated)", await req("GET", "/chat/users", { token: member }), 200);
check("member GET /chat/presence/online -> 200 (not over-gated)", await req("GET", "/chat/presence/online", { token: member }), 200);

// ───────────────────────────────────────────────────────────────────────────
// CALENDAR — events full CRUD + RSVP + export
// ───────────────────────────────────────────────────────────────────────────
const evList = await req("GET", `/calendar/events?start=${RANGE_START}&end=${RANGE_END}`, { token: owner });
check("owner GET /calendar/events -> 200", evList, 200);
check("member GET /calendar/events -> 200 (not over-gated)", await req("GET", `/calendar/events?start=${RANGE_START}&end=${RANGE_END}`, { token: member }), 200);
check("owner GET /calendar/events (missing params) -> 400", await req("GET", "/calendar/events", { token: owner }), 400);

// discover a real calendar event id (source === "event", id like "event-<n>")
const realEvent = (Array.isArray(evList.body) ? evList.body : []).find((e) => e.source === "event" && typeof e.id === "string" && e.id.startsWith("event-"));
const realEventId = realEvent ? Number(realEvent.id.split("-")[1]) : null;

if (realEventId != null) {
  check(`owner GET /calendar/events/${realEventId}/rsvp -> 200`, await req("GET", `/calendar/events/${realEventId}/rsvp`, { token: owner }), 200);
  check(`owner POST /calendar/events/${realEventId}/rsvp -> 200`, await req("POST", `/calendar/events/${realEventId}/rsvp`, { token: owner, body: { status: "accepted" } }), 200);
}

// ERROR PATHS
check("owner PUT /calendar/events/999999 -> 404", await req("PUT", "/calendar/events/999999", { token: owner, body: { title: `${FN}_nope` } }), 404);
check("owner PUT /calendar/events/abc -> 400 (ParseIntPipe)", await req("PUT", "/calendar/events/abc", { token: owner, body: {} }), 400);
check("owner GET /calendar/events/999999/rsvp -> 404", await req("GET", "/calendar/events/999999/rsvp", { token: owner }), 404);
check("owner POST /calendar/events/999999/rsvp -> 404", await req("POST", "/calendar/events/999999/rsvp", { token: owner, body: { status: "accepted" } }), 404);
check("owner POST /calendar/events/999999/rsvp malformed -> 400", await req("POST", "/calendar/events/999999/rsvp", { token: owner, body: { status: "maybe" } }), 400);
check("owner POST /calendar/events malformed (short title) -> 400", await req("POST", "/calendar/events", { token: owner, body: { title: "A", startDate: RANGE_START, endDate: RANGE_END } }), 400);

// WRITE lifecycle: create FN_TEST event -> verify -> update -> delete
const createEv = await req("POST", "/calendar/events", {
  token: owner,
  body: {
    title: `${FN} Event`,
    description: "functional test event",
    startDate: iso(2026, 5, 15, 10, 0),
    endDate: iso(2026, 5, 15, 11, 0),
    category: "general",
  },
});
check("owner POST /calendar/events -> 201", createEv, 201);
const newEventId = createEv.body?.event?.id;

if (newEventId != null) {
  const verify = await req("GET", `/calendar/events?start=${RANGE_START}&end=${RANGE_END}`, { token: owner });
  const present = (Array.isArray(verify.body) ? verify.body : []).some((e) => e.id === `event-${newEventId}`);
  check(`created event event-${newEventId} present in list`, { status: present ? 200 : 404 }, 200);

  check(`owner PUT /calendar/events/${newEventId} -> 200`, await req("PUT", `/calendar/events/${newEventId}`, { token: owner, body: { title: `${FN} Event Updated` } }), 200);
  check(`owner DELETE /calendar/events/${newEventId} -> 200`, await req("DELETE", `/calendar/events/${newEventId}`, { token: owner }), 200);
}

// member can create an event too (auth-only, not over-gated) — clean up after
const memberEv = await req("POST", "/calendar/events", {
  token: member,
  body: { title: `${FN} Member Event`, startDate: iso(2026, 5, 16, 10, 0), endDate: iso(2026, 5, 16, 11, 0), category: "general" },
});
check("member POST /calendar/events -> 201 (not over-gated)", memberEv, 201);
const memberEvId = memberEv.body?.event?.id;
if (memberEvId != null) {
  check(`member DELETE /calendar/events/${memberEvId} -> 200`, await req("DELETE", `/calendar/events/${memberEvId}`, { token: member }), 200);
}

check("owner GET /calendar/export -> 200", await req("GET", "/calendar/export?from=2026-01-01&to=2026-12-31", { token: owner }), 200);

// ───────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ───────────────────────────────────────────────────────────────────────────
const notifs = await req("GET", "/notifications", { token: owner });
check("owner GET /notifications -> 200", notifs, 200);
check("member GET /notifications -> 200 (not over-gated)", await req("GET", "/notifications", { token: member }), 200);
check("owner GET /notifications/unread-count -> 200", await req("GET", "/notifications/unread-count", { token: owner }), 200);

// mark a non-existent notification read -> no-op success 200 (no real row mutated)
check("owner PATCH /notifications/999999/read -> 200 (no-op)", await req("PATCH", "/notifications/999999/read", { token: owner }), 200);
check("owner PATCH /notifications/abc/read -> 400 (ParseIntPipe)", await req("PATCH", "/notifications/abc/read", { token: owner }), 400);

// read-all / clear-all mutate read state irreversibly; only safe when the user's list is empty.
const ownerNotifEmpty = Array.isArray(notifs.body) && notifs.body.length === 0;
if (ownerNotifEmpty) {
  check("owner PATCH /notifications/read-all -> 200 (no-op, empty)", await req("PATCH", "/notifications/read-all", { token: owner }), 200);
  check("owner DELETE /notifications/clear-all -> 200 (no-op, empty)", await req("DELETE", "/notifications/clear-all", { token: owner }), 200);
} else {
  // do not mutate real notifications; just confirm the routes are auth-gated (covered by 401 checks above)
  console.log("  SKIP read-all/clear-all execution: owner has real notifications (would be irreversible)");
}
// member list is empty in the demo org -> read-all is a safe no-op proving the route is not over-gated
const memberNotifs = await req("GET", "/notifications", { token: member });
if (Array.isArray(memberNotifs.body) && memberNotifs.body.length === 0) {
  check("member PATCH /notifications/read-all -> 200 (not over-gated)", await req("PATCH", "/notifications/read-all", { token: member }), 200);
}

// ───────────────────────────────────────────────────────────────────────────
// PUSH
// ───────────────────────────────────────────────────────────────────────────
check("owner GET /push/vapid-public-key -> 200", await req("GET", "/push/vapid-public-key", { token: owner }), 200);

const pushEndpoint = `https://fn-test.example.com/push/${FN}`;
check("owner POST /push/subscribe -> 201", await req("POST", "/push/subscribe", {
  token: owner,
  body: { endpoint: pushEndpoint, p256dh: `${FN}_p256dh`, auth: `${FN}_auth`, userAgent: "fn-test" },
}), 201);
check("owner DELETE /push/subscribe (cleanup) -> 200", await req("DELETE", `/push/subscribe?endpoint=${encodeURIComponent(pushEndpoint)}`, { token: owner }), 200);
// idempotent delete of an unknown endpoint -> 200
check("owner DELETE /push/subscribe unknown endpoint -> 200", await req("DELETE", `/push/subscribe?endpoint=${encodeURIComponent("https://fn-test.example.com/push/unknown")}`, { token: owner }), 200);
// malformed subscribe (endpoint not a url) -> 400, does not persist
check("owner POST /push/subscribe malformed -> 400", await req("POST", "/push/subscribe", { token: owner, body: { endpoint: "not-a-url", p256dh: "x", auth: "y" } }), 400);
// malformed unsubscribe (missing/invalid endpoint) -> 400
check("owner DELETE /push/subscribe (no endpoint) -> 400", await req("DELETE", "/push/subscribe", { token: owner }), 400);

process.exit(report("comms") ? 0 : 1);
