/**
 * U01 + U02: send a real message through a booted API and observe the mention
 * arriving at exactly one person. Mentions publish over Ably, not into a table,
 * so the only honest observation is a subscriber.
 *
 * Usage: pnpm -C backend start:dev, then: node --env-file=.env src/scripts/verify-chat-mention-delivery.mjs
 */
import postgres from "postgres";
import { SignJWT } from "jose";
import Ably from "ably";
import { randomUUID } from "node:crypto";

const API = process.env.API_URL ?? "http://localhost:1500";
const DB_URL = process.env.DATABASE_URL;
const SECRET = process.env.BACKEND_JWT_SECRET;
const ABLY_KEY = process.env.ABLY_API_KEY;

if (!DB_URL || !SECRET) {
  console.error("PREREQUISITE MISSING: DATABASE_URL and BACKEND_JWT_SECRET are required.");
  process.exit(2);
}
if (!ABLY_KEY) {
  console.error(
    "PREREQUISITE MISSING: ABLY_API_KEY is not set. Mentions publish over Ably; without it this proves nothing.",
  );
  process.exit(2);
}

const orgId = `mention-probe-${randomUUID().slice(0, 8)}`;
const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

const mintToken = (userId) =>
  new SignJWT({
    orgId,
    branchId: null,
    role: "OWNER",
    enabledModules: [],
    plan: null,
    isOrgOwner: true,
    sessionId: "mention-probe",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));

async function seed() {
  const sender = randomUUID();
  const alex = randomUUID();
  const alexander = randomUUID();

  await sql.begin(async (tx) => {
    const [seq] = await tx`SELECT nextval(pg_get_serial_sequence('organization_members','id')) AS id`;
    const ownerMembershipId = Number(seq.id);

    await tx`INSERT INTO organizations (id, name, slug, owner_membership_id)
             VALUES (${orgId}, ${orgId}, ${orgId}, ${ownerMembershipId})`;

    for (const [id, name] of [[sender, "Sender Probe"], [alex, "Alex"], [alexander, "Alexander"]])
      await tx`INSERT INTO users (id, email, name) VALUES (${id}, ${`${id}@probe.invalid`}, ${name})`;

    await tx`INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status)
             VALUES (${ownerMembershipId}, ${sender}, ${orgId}, 'OWNER', true, 'ACTIVE')`;
    // The chat actor contraction (0660) moved every chat table off `users.id` and
    // onto `organization_members.id`, so the membership is what the rows below
    // need — not the user id this script used to pass.
    const membershipOf = new Map([[sender, ownerMembershipId]]);
    for (const id of [alex, alexander]) {
      const [member] = await tx`INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
               VALUES (${id}, ${orgId}, 'MEMBER', false, 'ACTIVE') RETURNING id`;
      membershipOf.set(id, Number(member.id));
    }

    // `chk_chat_channels_privacy_matches_type` requires is_private = (type <> 'PUBLIC'),
    // so a GROUP channel must say so explicitly; the column default of false fails it.
    const [channel] = await tx`INSERT INTO chat_channels (org_id, name, type, is_private, created_by_membership_id)
                               VALUES (${orgId}, 'probe-channel', 'GROUP', true, ${ownerMembershipId}) RETURNING id`;
    for (const id of [sender, alex, alexander])
      await tx`INSERT INTO chat_channel_members (org_id, channel_id, membership_id, role)
               VALUES (${orgId}, ${Number(channel.id)}, ${membershipOf.get(id)}, 'MEMBER')`;

    seed.channelId = Number(channel.id);
  });

  return { sender, alex, alexander, channelId: seed.channelId };
}

function subscribe(realtime, userId) {
  const received = [];
  const channel = realtime.channels.get(`notifications:${orgId}:${userId}`);
  channel.subscribe("notification:mention", (msg) => received.push(msg.data));
  return { received, attached: channel.attach() };
}

async function main() {
  const { sender, alex, alexander, channelId } = await seed();
  console.log(`org      : ${orgId}`);
  console.log(`channel  : ${channelId}`);
  console.log(`alex     : ${alex}`);
  console.log(`alexander: ${alexander}\n`);

  const realtime = new Ably.Realtime({ key: ABLY_KEY, clientId: "mention-probe" });
  let failures = 0;

  try {
    const alexBox = subscribe(realtime, alex);
    const alexanderBox = subscribe(realtime, alexander);
    await Promise.all([alexBox.attached, alexanderBox.attached]);

    const res = await fetch(`${API}/chat/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await mintToken(sender)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "hey @alex can you look at this", mentionedUserIds: [alex] }),
    });
    const body = await res.text();
    console.log(`POST message -> ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      // Nothing was measured. This probe seeds its org into DATABASE_URL and then
      // talks to API_URL; a 401 on the very first send means the API on that port
      // is serving a DIFFERENT database (a dev server another worktree started is
      // the usual cause), so the seeded user does not exist as far as it is
      // concerned. Every assertion after this would fail for that reason and read
      // as "mentions are broken", which is the false report this exists to avoid.
      console.error(`  body: ${body.slice(0, 400)}`);
      console.error(
        "\nPREREQUISITE MISSING: the API at " + API + " rejected the probe's token.\n" +
          "  It must be booted against the SAME database as DATABASE_URL and share BACKEND_JWT_SECRET.\n" +
          "  Nothing about mention delivery was observed, so no finding is reported.",
      );
      process.exitCode = 2;
      return;
    }
    if (res.status !== 201) {
      console.error(`  body: ${body.slice(0, 400)}`);
      failures += 1;
    }

    await new Promise((r) => setTimeout(r, 6000));

    console.log(`\nAlex received      : ${alexBox.received.length}`);
    console.log(`Alexander received : ${alexanderBox.received.length}`);

    if (alexBox.received.length !== 1) {
      console.error(`FAIL: Alex should receive exactly 1 mention, got ${alexBox.received.length}`);
      failures += 1;
    }
    if (alexanderBox.received.length !== 0) {
      console.error(`FAIL: Alexander was mentioned by substring only and must receive 0, got ${alexanderBox.received.length}`);
      failures += 1;
    }

    // Second scenario: @everyone with no mentionedUserIds. mentionsEveryone() exists in
    // chat-mentions.ts; whether the send path calls it is what this observes.
    const before = { alex: alexBox.received.length, alexander: alexanderBox.received.length };
    const res2 = await fetch(`${API}/chat/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await mintToken(sender)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "@everyone standup in five" }),
    });
    console.log(`
POST @everyone -> ${res2.status}`);
    await new Promise((r) => setTimeout(r, 6000));
    const everyoneAlex = alexBox.received.length - before.alex;
    const everyoneAlexander = alexanderBox.received.length - before.alexander;
    console.log(`@everyone reached Alex      : ${everyoneAlex}`);
    console.log(`@everyone reached Alexander : ${everyoneAlexander}`);
    if (everyoneAlex === 0 && everyoneAlexander === 0)
      console.error("FINDING: @everyone notified nobody — the send path never expands it.");

    const [row] = await sql`SELECT count(*)::int AS n FROM chat_messages WHERE org_id = ${orgId}`;
    console.log(`chat_messages rows       : ${row.n}`);
    if (row.n !== 2) {
      console.error(`FAIL: expected 2 persisted messages, got ${row.n}`);
      failures += 1;
    }
  } finally {
    realtime.close();
    await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    await sql`DELETE FROM users WHERE email LIKE ${"%@probe.invalid"} AND id IN (
                SELECT id FROM users WHERE email LIKE ${"%@probe.invalid"})`;
    await sql.end();
  }

  console.log(failures === 0 ? "\nPASS — the mention reached exactly the person named.\n" : `\n${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await sql`DELETE FROM organizations WHERE id = ${orgId}`.catch(() => undefined);
  await sql.end().catch(() => undefined);
  process.exit(1);
});
