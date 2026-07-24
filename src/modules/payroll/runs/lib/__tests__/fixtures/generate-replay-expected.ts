import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { calcPayroll } from "../../calculation-engine";
import { REPLAY_FIXTURE_INPUT } from "./replay-fixture";

const snapshot = calcPayroll(REPLAY_FIXTURE_INPUT);
const { computedAt: _computedAt, ...stable } = snapshot;
const target = join(__dirname, "replay-expected.json");
writeFileSync(target, `${JSON.stringify(stable, null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
