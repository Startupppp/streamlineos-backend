/**
 * U01 + U02: send a real message through a booted API and observe the mention
 * arriving at exactly one person. Mentions publish over Ably, not into a table,
 * so the only honest observation is a subscriber.
 *
 * Usage: pnpm -C backend start:dev, then: node --env-file=.env src/scripts/verify-chat-mention-delivery.mjs
 */
import postgres from "postgres";
import { SignJWT, importJWK } from "jose";
import Ably from "ably";
import { randomUUID } from "node:crypto";

const API = process.env.API_URL ?? "http://localhost:1500";
const CELL_ID = process.env.CELL_ID?.trim() ?? "legacy-1";
const cellPrefixed = (channel) => `cell:${CELL_ID}:${channel}`;
// This script seeds and then DELETEs an organization, and it has no scratch-name guard.
// CHAT_PROBE_DATABASE_URL exists so the target can be named explicitly rather than
// inheriting .env's DATABASE_URL, which is a shared remote branch.
const DB_URL = process.env.CHAT_PROBE_DATABASE_URL || process.env.DATABASE_URL;
const ABLY_KEY = process.env.ABLY_API_KEY;
const SIGNING_KEYS = process.env.AUTH_SIGNING_KEYS?.trim();

if (!DB_URL) {
  console.error("CHAT_PROBE_DATABASE_URL or DATABASE_URL is required.");
  process.exit(1);
}
if (!SIGNING_KEYS) {
  console.error(
    "AUTH_SIGNING_KEYS is required. JwtKeyringService.verifyToken accepts EdDSA only —\n" +
      "BACKEND_JWT_SECRET / HS256 is no longer a valid signing path, so a token minted with\n" +
      "it is rejected 401 and this probe would report a delivery failure that is really an\n" +
      "authentication failure. The booted API must carry the SAME keyring value.",
  );
  process.exit(1);
}
if (!ABLY_KEY) {
  console.error(
    "PREREQUISITE MISSING: ABLY_API_KEY is not set. Mentions publish over Ably; without it this proves nothing.",
  );
  process.exit(2);
}

let keyring;
try {
  keyring = JSON.parse(SIGNING_KEYS);
} catch {
  console.error("AUTH_SIGNING_KEYS must be a valid JSON array of {kid, privateKey, publicKey}.");
  process.exit(1);
}
const signingKey = Array.isArray(keyring) ? keyring[keyring.length - 1] : null;
if (!signingKey?.kid || !signingKey?.privateKey) {
  console.error("AUTH_SIGNING_KEYS contains no usable {kid, privateKey} entry.");
  process.exit(1);
}

const orgId = `mention-probe-${randomUUID().slice(0, 8)}`;
const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

// Mirrors test/helpers/sign-token.ts: EdDSA, newest key in the ring, kid in the header.
const mintToken = async (userId) =>
  new SignJWT({
    orgId,
    branchId: null,
    role: "OWNER",
    enabledModules: [],
    plan: null,
    isOrgOwner: true,
    sessionId: "mention-probe",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: signingKey.kid })
    .setSubject(userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomUUID())
    .sign(await importJWK(signingKey.privateKey, "EdDSA"));

async function seed() {
  const sender = randomUUID();
  const alex = randomUUID();
  const alexander = randomUUID();

  await sql.begin(async (tx) => {
    const [seq] = await tx`SELECT nextval(pg_get_serial_sequence('organization_members','id')) AS id`;
    const ownerMembershipId = Number(seq.id);

    await tx`INSERT INTO organizations (id, name, slug, owner_membership_id)
             VALUES (${orgId}, ${orgId}, ${orgId}, ${ownerMembershipId})`;

    // An organization row alone is not reachable: RegionRegistry.regionForOrg throws
    // "has no region. It must be placed before its data can be reached", every
    // runInTenantTransaction for the org fails, MembershipStateService catches that and
    // falls back to UNKNOWN — and the API answers 403 ORG_MEMBERSHIP_INACTIVE for a
    // membership that is ACTIVE in the table. Placement is part of creating an org.
    // There is no FK from organization_placement to organizations, so this row is also
    // not removed by the organization DELETE in the teardown below.
    await tx`INSERT INTO organization_placement
               (organization_id, region, cell_id, database_shard, object_storage_region,
                search_cluster, write_fence_token, lease_expires_at)
             VALUES (${orgId}, 'primary', 'legacy-1', 'primary', 'auto',
                     'primary', ${randomUUID()}, now() + interval '1 day')`;

    for (const [id, name] of [[sender, "Sender Probe"], [alex, "Alex"], [alexander, "Alexander"]])
      await tx`INSERT INTO users (id, email, name) VALUES (${id}, ${`${id}@probe.invalid`}, ${name})`;

    await tx`INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status)
             VALUES (${ownerMembershipId}, ${sender}, ${orgId}, 'OWNER', true, 'ACTIVE')`;
    // Chat is keyed on membership, not user (migration 0800_chat_actor_legacy_drop), so the
    // membership ids have to be carried forward rather than reusing the user uuids below.
    const membershipOf = new Map([[sender, ownerMembershipId]]);
    for (const id of [alex, alexander]) {
      const [row] = await tx`INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
               VALUES (${id}, ${orgId}, 'MEMBER', false, 'ACTIVE') RETURNING id`;
      membershipOf.set(id, Number(row.id));
    }

    // `chat_channels.created_by` and `chat_channel_members.user_id` were dropped by
    // migration 0800_chat_actor_legacy_drop in favour of the composite membership keys
    // (org_id, created_by_membership_id) and (org_id, membership_id). This seed still wrote
    // the pre-0800 column names, so every run died 42703 before reaching an assertion.
    // chk_chat_channels_privacy_matches_type is `is_private = (type <> 'PUBLIC')`, and
    // is_private defaults to false — so a GROUP channel must set it explicitly.
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
  const channel = realtime.channels.get(cellPrefixed(`notifications:${orgId}:${userId}`));
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
    await new Promise((r) => setTimeout(r, 15000));
    const everyoneAlex = alexBox.received.length - before.alex;
    const everyoneAlexander = alexanderBox.received.length - before.alexander;
    console.log(`@everyone reached Alex      : ${everyoneAlex}`);
    console.log(`@everyone reached Alexander : ${everyoneAlexander}`);
    if (everyoneAlex === 0 && everyoneAlexander === 0)
      console.error("FINDING: @everyone notification did not arrive within the 6-second window — the fan-out runs asynchronously and may deliver after this check.");

    const [row] = await sql`SELECT count(*)::int AS n FROM chat_messages WHERE org_id = ${orgId}`;
    console.log(`chat_messages rows       : ${row.n}`);
    if (row.n !== 2) {
      console.error(`FAIL: expected 2 persisted messages, got ${row.n}`);
      failures += 1;
    }
  } finally {
    realtime.close();
    await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    // organization_placement has no FK to organizations, so it outlives the DELETE above.
    await sql`DELETE FROM organization_placement WHERE organization_id = ${orgId}`;
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
  await sql`DELETE FROM organization_placement WHERE organization_id = ${orgId}`.catch(() => undefined);
  await sql.end().catch(() => undefined);
  process.exit(1);
});
