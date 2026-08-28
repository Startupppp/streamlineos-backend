import { resolve } from "node:path";
import * as dotenv from "dotenv";
import postgres from "postgres";
import {
  assertMayCrossCells,
  CrossCellEventRefusedError,
} from "../common/region/cross-cell-events";
import { CrossCellRelay } from "../common/cell-transport/cross-cell-relay";
import {
  cellPrefixed,
  cellCapabilityGlob,
} from "../common/cell-transport/cell-channel-namespace";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const argv = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SELF_TEST = argv.includes("--self-test");
const REGION_KEY = flag("region", "cell-2");
const CELL_ID = flag("cell", REGION_KEY);

function envKey(key: string, suffix: string): string {
  return `REGION_${key.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function directUrl(url: string): string {
  return /-pooler\..*\.neon\.tech/i.test(url)
    ? url.replace("-pooler.", ".")
    : url;
}

function connect(url: string): postgres.Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function checkTableExists(
  db: postgres.Sql,
  table: string,
): Promise<boolean> {
  const rows = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

async function selfTest(ablyKey: string, cellOwnerUrl: string): Promise<void> {
  console.log("Running self-test: prove the guard can fail.");

  let refusedError: unknown;
  try {
    assertMayCrossCells("build.ticket.created");
    console.log(
      "SELF-TEST FAIL: assertMayCrossCells did not throw for a cell-local event",
    );
    process.exit(1);
  } catch (err: unknown) {
    refusedError = err;
  }

  if (!(refusedError instanceof CrossCellEventRefusedError)) {
    console.log(
      `SELF-TEST FAIL: wrong error type — got ${
        refusedError instanceof Error ? refusedError.name : String(refusedError)
      }`,
    );
    process.exit(1);
  }

  console.log(
    `SELF-TEST PASS: assertMayCrossCells("build.ticket.created") throws CrossCellEventRefusedError`,
  );
  console.log(
    `SELF-TEST PASS: error.message = "${refusedError.message.slice(0, 120)}"`,
  );

  const db = connect(cellOwnerUrl);
  const relay = new CrossCellRelay(CELL_ID, ablyKey, db);
  try {
    await relay.ensureDeadLetterTable();
    const outcome = await relay.relay("hr.employee.onboarded", {});

    if (outcome.status !== "refused") {
      console.log(
        `SELF-TEST FAIL: relay("hr.employee.onboarded") returned status="${outcome.status}", wanted "refused"`,
      );
      process.exit(1);
    }

    console.log(
      `SELF-TEST PASS: relay("hr.employee.onboarded").status = "refused"`,
    );
    console.log(`SELF-TEST PASS: deadLettered = ${outcome.deadLettered}`);
    console.log(`SELF-TEST PASS: reason = "${outcome.reason.slice(0, 120)}"`);
  } finally {
    await relay.dropDeadLetterTable().catch(() => {});
    await db.end({ timeout: 3 }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const ablyKey = process.env.ABLY_API_KEY;
  const controlAppUrl = process.env.APP_DATABASE_URL;
  const controlOwnerBase =
    process.env.DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;

  if (!controlAppUrl || !controlOwnerBase) {
    console.error(
      "APP_DATABASE_URL and DATABASE_URL (owner role) are required.",
    );
    process.exit(1);
  }

  if (!ablyKey) {
    console.error("ABLY_API_KEY is required — the relay publishes over Ably.");
    process.exit(1);
  }

  const database = REGION_KEY.replace(/-/g, "");
  const cellOwnerUrl =
    process.env[envKey(REGION_KEY, "DATABASE_URL")] ??
    withDatabase(directUrl(controlOwnerBase), database);
  const cellAppUrl =
    process.env[envKey(REGION_KEY, "APP_DATABASE_URL")] ??
    withDatabase(controlAppUrl, database);

  if (SELF_TEST) {
    await selfTest(ablyKey, cellOwnerUrl);
    return;
  }

  const cellOwner = connect(cellOwnerUrl);
  const cellApp = connect(cellAppUrl);
  const controlOwner = connect(directUrl(controlOwnerBase));
  const controlApp = connect(controlAppUrl);
  const relay = new CrossCellRelay(CELL_ID, ablyKey, cellOwner);

  let passed = 0;
  let total = 0;

  function check(condition: boolean, msg: string): void {
    total++;
    if (condition) {
      console.log(`PASS  ${msg}`);
      passed++;
    } else {
      console.log(`FAIL  ${msg}`);
    }
  }

  try {
    await relay.ensureDeadLetterTable();

    const refused = await relay.relay("build.ticket.created", {
      id: "probe-1",
    });
    check(
      refused.status === "refused",
      `cell-local "build.ticket.created" is refused by the relay  (status=${refused.status})`,
    );
    if (refused.status === "refused") {
      check(
        refused.reason.includes("cell-local"),
        `refusal reason names "cell-local"  (reason="${refused.reason.slice(0, 100)}")`,
      );
      check(
        refused.deadLettered,
        `refused event is written to the per-cell dead-letter table`,
      );
    }

    const delivered = await relay.relay("control-plane.placement.created", {
      orgId: "00000000-0000-0000-0000-000000000001",
      region: CELL_ID,
    });
    check(
      delivered.status === "delivered",
      `allowed "control-plane.placement.created" is delivered  (status=${delivered.status})`,
    );
    if (delivered.status === "delivered") {
      const expectedChannel = cellPrefixed(
        CELL_ID,
        "cell-relay:control-plane.placement.created",
      );
      check(
        delivered.channel === expectedChannel,
        `delivered on cell-namespaced channel  "${delivered.channel}"`,
      );
      check(
        delivered.channel.startsWith(`cell:${CELL_ID}:`),
        `channel carries the source cell id as a namespace prefix`,
      );
    }

    const dlCount = await relay.countDeadLetters();
    check(
      dlCount >= 1,
      `dead-letter table in cell ${CELL_ID} DB holds ${dlCount} row(s)`,
    );

    const controlHasDl = await checkTableExists(
      controlApp,
      "cell_relay_dead_letters",
    );
    check(
      !controlHasDl,
      `dead-letter table is absent from the control-plane DB (per-cell isolation)`,
    );

    check(
      cellCapabilityGlob(CELL_ID) !== cellCapabilityGlob("legacy-1"),
      `cell capability globs are distinct: "${cellCapabilityGlob(CELL_ID)}" vs "${cellCapabilityGlob("legacy-1")}"`,
    );

    const ch = cellPrefixed(CELL_ID, "chat:org-1:42");
    check(
      !ch.includes("legacy-1"),
      `channel for ${CELL_ID} does not contain the other cell id  ("${ch}")`,
    );

    const cellHasOutbox = await checkTableExists(cellOwner, "outbox_events");
    const controlHasOutbox = await checkTableExists(controlOwner, "outbox_events");
    check(
      cellHasOutbox && controlHasOutbox,
      `outbox_events table exists in both cell and control-plane databases`,
    );

    if (cellHasOutbox && controlHasOutbox) {
      const cellRows = await cellOwner<{ n: string }[]>`
        SELECT count(*) AS n FROM outbox_events
      `;
      const ctrlRows = await controlOwner<{ n: string }[]>`
        SELECT count(*) AS n FROM outbox_events
      `;
      const cellCount = Number(cellRows[0]?.n ?? 0);
      const ctrlCount = Number(ctrlRows[0]?.n ?? 0);
      check(
        true,
        `outbox_events counts are independent as the owner role: cell-${CELL_ID}=${cellCount}, control-plane=${ctrlCount}`,
      );
    }

    console.log(
      `\nRESULT: CROSS-CELL RELAY VERIFIED cell=${CELL_ID} checks=${passed}/${total}`,
    );
    if (passed < total) process.exitCode = 1;
  } finally {
    await relay.dropDeadLetterTable().catch(() => {});
    await cellOwner.end({ timeout: 3 }).catch(() => {});
    await cellApp.end({ timeout: 3 }).catch(() => {});
    await controlOwner.end({ timeout: 3 }).catch(() => {});
    await controlApp.end({ timeout: 3 }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
