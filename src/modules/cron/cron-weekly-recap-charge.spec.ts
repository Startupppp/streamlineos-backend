import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "cron-weekly-recap.service.ts");

describe("cron-weekly-recap.service — charge field declaration", () => {
  it("declares charge: false on the final.weekly-recap gateway call (platform cost, not tenant charge)", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/charge\s*:\s*false/);
    expect(src).toContain("final.weekly-recap");
  });

  it("does not omit the charge field (absent === broken billing)", () => {
    const src = readFileSync(SRC, "utf8");
    const recapBlock = src.slice(src.indexOf("final.weekly-recap") - 200, src.indexOf("final.weekly-recap") + 200);
    expect(recapBlock).toMatch(/charge\s*:/);
  });
});
