import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * `attemptNurtureStep` was a private method of NurtureStepSenderService until
 * the file-size split (0601bb775) moved it to `lib/nurture-step-attempt.ts` and
 * exported it. Reached through the sender's sweep, it runs only after the
 * per-tick send cap and the step's cadence wait have been applied. Called
 * directly, it skips both. Its one side effect still goes through
 * `composeAndHold`, which always holds the message, and the enrolment claim
 * still prevents a double step. But "send faster than the cadence allows" is
 * exactly the complaint a nurture sequence must never earn.
 *
 * So the split may export it, and only the sender may import it.
 */
const SRC = resolve(__dirname, "../../..");

function importersOf(pattern: string): string[] {
  const out = execSync(
    `grep -rlE ${JSON.stringify(pattern)} ${JSON.stringify(SRC)} --include=*.ts || true`,
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((abs) => abs.slice(SRC.length + 1))
    .filter((file) => !file.endsWith(".spec.ts"));
}

describe("nurture step attempt boundary", () => {
  it("is imported only by the step sender, which applies the send cap and cadence first", () => {
    const importers = importersOf('from "[^"]*lib/nurture-step-attempt"');
    expect(importers).toEqual(["modules/autonomy/sequences/nurture-step-sender.service.ts"]);
  });
});
