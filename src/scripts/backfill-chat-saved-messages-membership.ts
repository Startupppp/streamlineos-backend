import "dotenv/config";
import postgres from "postgres";

const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

  console.log(`[backfill-chat-saved-messages-membership] DRY_RUN=${DRY_RUN} BATCH_SIZE=${BATCH_SIZE}`);

  let lastId = 0;
  let updatedTotal = 0;
  let unmappableTotal = 0;
  let duplicateTotal = 0;

  for (;;) {
    const rows = await client<{ id: number; org_id: string; user_id: string }[]>`
      SELECT id, org_id, user_id
      FROM chat_saved_messages
      WHERE membership_id IS NULL
        AND id > ${lastId}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `;

    if (rows.length === 0) break;

    lastId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const [member] = await client<{ id: number }[]>`
        SELECT id
        FROM organization_members
        WHERE org_id = ${row.org_id}
          AND user_id = ${row.user_id}
          AND status = 'ACTIVE'
        LIMIT 1
      `;

      if (!member) {
        unmappableTotal++;
        console.warn(`[backfill] id=${row.id} org=${row.org_id} user=${row.user_id} → NO ACTIVE MEMBERSHIP`);
        continue;
      }

      if (!DRY_RUN) {
        try {
          await client`
            UPDATE chat_saved_messages
            SET membership_id = ${member.id}
            WHERE id = ${row.id}
              AND membership_id IS NULL
          `;
          updatedTotal++;
        } catch (err) {
          if (err instanceof Error && err.message.includes("23505")) {
            duplicateTotal++;
            console.warn(`[backfill] id=${row.id} DUPLICATE — skipping`);
          } else {
            throw err;
          }
        }
      } else {
        updatedTotal++;
      }
    }

    console.log(`[backfill] cursor=${lastId} updated=${updatedTotal} unmappable=${unmappableTotal} duplicates=${duplicateTotal}`);
  }

  console.log(`[backfill] DONE updated=${updatedTotal} unmappable=${unmappableTotal} duplicates=${duplicateTotal}`);

  await client.end();
}

run().catch((err) => {
  console.error("[backfill] FATAL", err);
  process.exit(1);
});
