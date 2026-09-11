import { execFileSync } from "node:child_process";
import { resolvePoolConfig } from "./pool.config";

const CONNECTION_URL =
  process.env.TZ_ROUND_TRIP_DATABASE_URL ??
  process.env.APP_DATABASE_URL ??
  process.env.DATABASE_URL;

const INSTANTS: ReadonlyArray<string> = [
  "2026-09-02T12:00:00.000Z",
  "2026-01-01T00:00:00.000Z",
  "2026-12-31T23:59:59.999Z",
  "2026-03-29T00:59:00.000Z",
  "2026-03-29T02:01:00.000Z",
  "1999-12-31T18:30:00.000Z",
];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Node reads its timezone from `process.env.TZ` at startup and jest's worker
 * environment does not propagate a later assignment, so the process half of the
 * round trip can only be varied by owning the process.
 */
const PROBE = `
const postgres = require("postgres");
const [url, sessionTimeZone, ...instants] = process.argv.slice(1);
const connection = { application_name: "tz-round-trip" };
if (sessionTimeZone !== "-") connection.TimeZone = sessionTimeZone;
const sql = postgres(url, { prepare: false, max: 1, connection });
(async () => {
  const [{ tz }] = await sql\`select current_setting('TimeZone') as tz\`;
  const readings = [];
  for (const instant of instants) {
    const value = new Date(instant);
    const [row] = await sql\`select \${value}::timestamp as naive, \${value}::timestamptz as aware\`;
    readings.push({ instant, naive: row.naive.toISOString(), aware: row.aware.toISOString() });
  }
  await sql.end();
  process.stdout.write(JSON.stringify({ sessionTimeZone: tz, offsetMinutes: new Date().getTimezoneOffset(), readings }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`;

interface Reading {
  instant: string;
  naive: string;
  aware: string;
}

interface ProbeResult {
  sessionTimeZone: string;
  offsetMinutes: number;
  readings: Reading[];
}

function roundTrip(processTz: string, sessionTimeZone: string): ProbeResult {
  const stdout = execFileSync(
    process.execPath,
    ["-e", PROBE, "--", CONNECTION_URL as string, sessionTimeZone, ...INSTANTS],
    { env: { ...process.env, TZ: processTz }, cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(stdout) as ProbeResult;
}

function driftMs(reading: Reading): number {
  return new Date(reading.naive).getTime() - new Date(reading.instant).getTime();
}

describe("timestamp round trip through the project's own driver", () => {
  if (!CONNECTION_URL) {
    throw new Error(
      "TZ_ROUND_TRIP_DATABASE_URL, APP_DATABASE_URL or DATABASE_URL must be set for the timestamp round-trip proof",
    );
  }

  it("pins the database session to UTC from the pool configuration the application itself resolves", () => {
    expect(resolvePoolConfig(process.env).options.connection?.TimeZone).toBe("UTC");
    expect(roundTrip("UTC", "UTC").sessionTimeZone).toBe("UTC");
  });

  it("returns every instant unchanged from a `timestamp without time zone`, which is what 1388 of this schema's columns are", () => {
    const result = roundTrip("UTC", "UTC");
    expect(result.offsetMinutes).toBe(0);
    for (const reading of result.readings) {
      expect(reading.naive).toBe(reading.instant);
    }
  });

  it("returns every instant unchanged from a `timestamptz` too, in every one of the four pairings", () => {
    for (const [processTz, sessionTz] of [
      ["UTC", "UTC"],
      ["UTC", "-"],
      ["Asia/Kolkata", "UTC"],
      ["Asia/Kolkata", "-"],
    ] as const) {
      for (const reading of roundTrip(processTz, sessionTz).readings) {
        expect(reading.aware).toBe(reading.instant);
      }
    }
  });

  it("shifts every naive value forward by the session offset when the session is left unpinned, which is the regression the pin prevents", () => {
    const result = roundTrip("UTC", "Asia/Kolkata");
    expect(result.sessionTimeZone).toBe("Asia/Kolkata");
    for (const reading of result.readings) {
      expect(driftMs(reading)).toBe(IST_OFFSET_MS);
    }
  });

  it("shifts every naive value backward when the process leaves UTC, so TZ=UTC in the image is half the guarantee and not decoration", () => {
    for (const reading of roundTrip("Asia/Kolkata", "UTC").readings) {
      expect(driftMs(reading)).toBe(-IST_OFFSET_MS);
    }
  });

  it("survives a northern-hemisphere DST boundary unchanged, because neither end observes a transition once both are UTC", () => {
    const readings = roundTrip("UTC", "UTC").readings.filter((reading) =>
      reading.instant.startsWith("2026-03-29"),
    );
    expect(readings).toHaveLength(2);
    for (const reading of readings) expect(driftMs(reading)).toBe(0);
  });
});
