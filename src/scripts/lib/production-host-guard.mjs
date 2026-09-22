export const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertProductionSafeTarget(url, allowProduction) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (!matched) return { allowed: true, reason: "not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' — ALLOW_PRODUCTION_MIGRATION=1 acknowledged` };
  return { allowed: false, reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately` };
}

export function runTargetGuardSelfTest(label) {
  const cases = [
    ["a local host is allowed", assertProductionSafeTarget("postgresql://u:p@127.0.0.1:5432/app", undefined), true],
    ["an unset url is refused rather than treated as local", assertProductionSafeTarget(undefined, undefined), false],
    ["an empty url is refused rather than treated as local", assertProductionSafeTarget("", undefined), false],
  ];

  for (const pattern of PRODUCTION_HOST_PATTERNS) {
    const url = `postgresql://u:p@host${pattern}/app`;
    cases.push([`'${pattern}' is refused without the acknowledgement`, assertProductionSafeTarget(url, undefined), false]);
    cases.push([`'${pattern}' is allowed once acknowledged`, assertProductionSafeTarget(url, "1"), true]);
    cases.push([`'${pattern}' is not unlocked by an acknowledgement of '0'`, assertProductionSafeTarget(url, "0"), false]);
  }

  if (PRODUCTION_HOST_PATTERNS.length === 0) {
    console.error("FAIL: PRODUCTION_HOST_PATTERNS is empty, so every case above is vacuous.");
    process.exit(1);
  }

  let failed = 0;
  for (const [name, verdict, expected] of cases)
    if (verdict.allowed !== expected) {
      console.error(`FAIL: ${name} — expected allowed=${expected}, got '${verdict.reason}'`);
      failed++;
    }
  if (failed) process.exit(1);
  console.log(`PASS: ${label} target guard, ${cases.length} cases over ${PRODUCTION_HOST_PATTERNS.length} production host patterns.`);
  process.exit(0);
}
