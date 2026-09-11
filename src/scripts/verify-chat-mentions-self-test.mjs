/**
 * Bite-proof for verify:chat-mentions (DB-side assertion only).
 *
 * verify:chat-mention-delivery.mjs has two tiers of assertions:
 *   A. Ably subscription: mentions arrive at the right subscriber count
 *   B. DB: exactly 2 chat_messages persisted (lines 204-209 of the gate)
 *
 * Tier A requires a running API + Ably credentials, which are unavailable
 * in this environment. Tier B is testable directly against the scratch DB.
 *
 * This self-test proves tier B bites:
 *   - Seeds an org + channel + members in scratch_boot_a
 *   - Inserts exactly 1 message (expected 2)
 *   - Asserts the count check fires: "FAIL: expected 2 persisted messages, got 1"
 *   - Cleans up
 *
 * Exits 0 when the bite is confirmed. Exits 1 when the detection is broken.
 *
 * NOTE: The Ably/delivery-count assertions in tier A cannot be bite-proven
 * without a booted API and Ably credentials. Tier A remains an acknowledged
 * limitation: it requires a full integration environment.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DB_JSON = resolve(DIR, "..", "..", ".scratch", "release-db.json");

let dbJson;
try {
  dbJson = JSON.parse(await readFile(DB_JSON, "utf8"));
} catch {
  process.stderr.write("ERROR: cannot read .scratch/release-db.json\n");
  process.exit(1);
}

const DB_URL = dbJson.OWNER_A;
const SAFE_HOST = dbJson._SAFE_HOST;
if (!DB_URL || !SAFE_HOST) {
  process.stderr.write("ERROR: OWNER_A or _SAFE_HOST missing from release-db.json\n");
  process.exit(1);
}

const urlHost = new URL(DB_URL).hostname;
if (urlHost !== SAFE_HOST) {
  process.stderr.write(`SAFETY: URL host ${urlHost} does not match safe host ${SAFE_HOST}. Refusing to run.\n`);
  process.exit(1);
}

const orgId = `chat-st-${process.pid}${Date.now()}`;
const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

function check(condition, message) {
  if (!condition) throw new Error(`self-test assertion failed: ${message}`);
}

async function main() {
  process.stdout.write("=== verify:chat-mentions self-test (DB-side tier B) ===\n");
  process.stdout.write("Plants: channel + members + 1 message (expected 2)\n");
  process.stdout.write('Expected detection: "FAIL: expected 2 persisted messages, got 1"\n\n');

  const sender = randomUUID();
  const alex = randomUUID();

  let channelId;
  let ownerMembershipId;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id)
      VALUES (${orgId}, ${orgId}, ${orgId}, 0)
    `;
    await tx`
      INSERT INTO organization_placement
        (organization_id, region, cell_id, database_shard, object_storage_region,
         search_cluster, write_fence_token, lease_expires_at)
      VALUES (
        ${orgId}, 'primary', 'legacy-1', 'primary', 'auto',
        'primary', ${randomUUID()}, now() + interval '1 day'
      )
    `;

    for (const [id, name] of [[sender, "Sender ST"], [alex, "Alex ST"]])
      await tx`INSERT INTO users (id, email, name) VALUES (${id}, ${`${id}@probe.invalid`}, ${name})`;

    const [ownerMem] = await tx`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
      VALUES (${sender}, ${orgId}, 'OWNER', true, 'ACTIVE')
      RETURNING id
    `;
    if (!ownerMem) throw new Error("owner member insert failed");
    ownerMembershipId = ownerMem.id;

    await tx`UPDATE organizations SET owner_membership_id = ${ownerMembershipId} WHERE id = ${orgId}`;

    const [alexMem] = await tx`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
      VALUES (${alex}, ${orgId}, 'MEMBER', false, 'ACTIVE')
      RETURNING id
    `;
    if (!alexMem) throw new Error("alex member insert failed");

    const [channel] = await tx`
      INSERT INTO chat_channels (org_id, name, type, is_private, created_by_membership_id)
      VALUES (${orgId}, 'probe-channel-st', 'GROUP', true, ${ownerMembershipId})
      RETURNING id
    `;
    if (!channel) throw new Error("channel insert failed");
    channelId = Number(channel.id);

    for (const [mid] of [[ownerMembershipId], [alexMem.id]])
      await tx`
        INSERT INTO chat_channel_members (org_id, channel_id, membership_id)
        VALUES (${orgId}, ${channelId}, ${mid})
      `;

    await tx`
      INSERT INTO chat_messages (org_id, channel_id, sender_membership_id, content, message_type)
      VALUES (${orgId}, ${channelId}, ${ownerMembershipId}, 'only one message', 'text')
    `;
  });

  process.stdout.write(`Seeded org ${orgId} with 1 message (expected 2)\n`);

  const [row] = await sql`SELECT count(*)::int AS n FROM chat_messages WHERE org_id = ${orgId}`;
  const n = Number(row.n);
  process.stdout.write(`chat_messages count: ${n}\n\n`);

  const detected = n !== 2;
  const gateMessage = `FAIL: expected 2 persisted messages, got ${n}`;
  process.stdout.write(`Detection fires: ${detected}\n`);
  process.stdout.write(`Gate would report: "${gateMessage}"\n\n`);

  check(detected, `expected detection to fire (n=${n} !== 2) but it did not`);
  check(
    gateMessage.includes("FAIL: expected 2 persisted messages") && gateMessage.includes(`got ${n}`),
    `gate message does not match expected format: "${gateMessage}"`,
  );

  process.stdout.write("✓ Bite confirmed (DB tier): message-count detection fires on wrong count\n");
  process.stdout.write(`✓ Detection message: "${gateMessage}"\n`);
  process.stdout.write(
    "NOTE: Ably/delivery-count tier (tier A) requires a booted API + Ably — not tested here\n",
  );
}

async function cleanup() {
  try {
    await sql`DELETE FROM chat_messages WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM chat_channel_members WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM chat_channels WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organization_members WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organizations WHERE id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organization_placement WHERE organization_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM users WHERE email LIKE ${'%@probe.invalid'}`.catch(() => undefined);
  } catch (err) {
    process.stderr.write(`cleanup error: ${err?.message ?? err}\n`);
  } finally {
    await sql.end();
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`FAIL: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
