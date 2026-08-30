import { createInterface } from "node:readline";

const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Read JSON log lines from stdin and print a per-cell breakdown.

  node src/scripts/read-cell-logs.mjs [--json]

Each log line must be a JSON object. Lines that carry a "cellId" field are
grouped and counted. Lines without one are counted under "(no-cell)".

  journalctl -u streamlineos-api | node src/scripts/read-cell-logs.mjs
`);
  process.exit(0);
}

const JSON_OUT = argv.includes("--json");

const counts = new Map();
let total = 0;
let unparseable = 0;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  total++;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    unparseable++;
    return;
  }

  const cellId = typeof parsed.cellId === "string" ? parsed.cellId : "(no-cell)";
  counts.set(cellId, (counts.get(cellId) ?? 0) + 1);
});

rl.on("close", () => {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      total,
      unparseable,
      cells: Object.fromEntries(sorted),
    }, null, 2));
    return;
  }

  console.log(`Total lines: ${total}  Unparseable: ${unparseable}\n`);
  console.log("cellId".padEnd(40) + "lines");
  console.log("-".repeat(50));
  for (const [cellId, count] of sorted) {
    console.log(cellId.padEnd(40) + count);
  }
});
