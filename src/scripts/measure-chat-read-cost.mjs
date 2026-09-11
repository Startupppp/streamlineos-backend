/**
 * Buffer-cost measurement for the Chat hot reads.
 *
 * Runs as the NON-OWNER application role with the tenant GUC set, because the owner holds
 * BYPASSRLS and its plans omit the RLS qual that dominates these queries. Reports shared
 * buffers (hit + read) and rows, which is what a plan costs regardless of cache warmth --
 * wall-clock on a warm cache says nothing.
 *
 *   APP_DATABASE_URL=postgresql://streamline_app:...@127.0.0.1:5432/scratch_local \
 *     node src/scripts/measure-chat-read-cost.mjs
 */
import postgres from "postgres";

const URL_VALUE = process.env.APP_DATABASE_URL;
const OWNER_URL = process.env.DATABASE_URL;
if (!URL_VALUE || !OWNER_URL) {
  console.error(
    "both APP_DATABASE_URL (streamline_app, measured) and DATABASE_URL (owner, fixtures only) are required",
  );
  process.exit(1);
}

const MESSAGE_PAGE_SIZE = 50;
const CHANNEL_LIST_LIMIT = 100;

function buffersOf(plan) {
  let hit = 0;
  let read = 0;
  let rows = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    hit += node["Shared Hit Blocks"] ?? 0;
    read += node["Shared Read Blocks"] ?? 0;
    if (rows === 0) rows = node["Actual Rows"] ?? 0;
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return { buffers: hit + read, hit, read, rows };
}

async function measure(sql, label, query, params) {
  const [row] = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
    params,
  );
  const explain = row["QUERY PLAN"][0];
  const stats = buffersOf(explain.Plan);
  return { label, ...stats, planMs: explain["Execution Time"] };
}

async function main() {
  const owner = postgres(OWNER_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const sql = postgres(URL_VALUE, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const [busiest] = await owner`
      SELECT org_id, channel_id, count(*)::int AS n
      FROM chat_messages GROUP BY org_id, channel_id ORDER BY n DESC LIMIT 1`;
    if (!busiest) throw new Error("no chat_messages rows to measure against");

    const [member] = await owner`
      SELECT membership_id, count(*)::int AS channels FROM chat_channel_members
      WHERE org_id = ${busiest.org_id}
      GROUP BY membership_id ORDER BY channels DESC LIMIT 1`;

    const [totals] = await owner`
      SELECT (SELECT count(*)::int FROM chat_messages WHERE org_id = ${busiest.org_id}) AS msgs,
             (SELECT count(*)::int FROM chat_channels WHERE org_id = ${busiest.org_id}) AS channels`;
    await owner.end({ timeout: 5 });

    await sql.unsafe("BEGIN");
    await sql.unsafe("SELECT set_config('app.organization_id', $1, true)", [busiest.org_id]);
    const [role] = await sql`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    if (role.bypassrls)
      console.warn(`WARNING: ${role.current_user} has BYPASSRLS — these numbers hide the RLS qual.`);

    console.log(
      `role=${role.current_user} org=${busiest.org_id} channel=${busiest.channel_id} ` +
        `(${busiest.n} msgs in channel, ${totals.msgs} in org across ${totals.channels} channels; ` +
        `busiest member is in ${member?.channels ?? 0})\n`,
    );

    const results = [];
    results.push(
      await measure(
        sql,
        "message page (keyset, newest first)",
        `SELECT id, content, channel_position, created_at FROM chat_messages
          WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
          ORDER BY channel_position DESC LIMIT ${MESSAGE_PAGE_SIZE}`,
        [busiest.org_id, busiest.channel_id],
      ),
    );
    results.push(
      await measure(
        sql,
        "message page 2 (keyset from a cursor)",
        `SELECT id, content, channel_position, created_at FROM chat_messages
          WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
            AND channel_position < $3
          ORDER BY channel_position DESC LIMIT ${MESSAGE_PAGE_SIZE}`,
        [busiest.org_id, busiest.channel_id, Math.max(busiest.n - MESSAGE_PAGE_SIZE, 1)],
      ),
    );
    results.push(
      await measure(
        sql,
        "my channel list",
        `SELECT c.id, c.name, c.type, c.message_count FROM chat_channels c
          INNER JOIN chat_channel_members m
             ON m.org_id = c.org_id AND m.channel_id = c.id
          WHERE c.org_id = $1 AND m.membership_id = $2 AND c.is_archived = false
          ORDER BY c.id DESC LIMIT ${CHANNEL_LIST_LIMIT}`,
        [busiest.org_id, member?.membership_id ?? 0],
      ),
    );
    results.push(
      await measure(
        sql,
        "unread totals across my channels",
        `SELECT c.id, GREATEST(c.message_count - COALESCE(m.last_read_position, 0), 0) AS unread
           FROM chat_channels c
           INNER JOIN chat_channel_members m
              ON m.org_id = c.org_id AND m.channel_id = c.id
          WHERE c.org_id = $1 AND m.membership_id = $2 AND c.is_archived = false`,
        [busiest.org_id, member?.membership_id ?? 0],
      ),
    );
    results.push(
      await measure(
        sql,
        "poll since a cursor (reconnect replay)",
        `SELECT id, content, channel_position FROM chat_messages
          WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
            AND channel_position > $3
          ORDER BY channel_position ASC LIMIT ${MESSAGE_PAGE_SIZE}`,
        [busiest.org_id, busiest.channel_id, Math.max(busiest.n - 10, 0)],
      ),
    );

    await sql.unsafe("ROLLBACK");

    const pad = (s, n) => String(s).padEnd(n);
    console.log(
      `${pad("query", 40)}${pad("buffers", 10)}${pad("read", 8)}${pad("rows", 8)}ms`,
    );
    for (const r of results)
      console.log(
        `${pad(r.label, 40)}${pad(r.buffers, 10)}${pad(r.read, 8)}${pad(r.rows, 8)}${r.planMs.toFixed(2)}`,
      );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
