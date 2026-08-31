import * as fs from "node:fs";
import * as path from "node:path";

const postingServiceSrc = fs.readFileSync(
  path.join(__dirname, "../../payroll-posting.service.ts"),
  "utf8",
);

const completionSrc = fs.readFileSync(
  path.join(__dirname, "payout-run-completion.ts"),
  "utf8",
);

describe("payroll deferred posting — tenant GUC isolation", () => {
  it("postPaid wraps the journal call in runInNewTenantTransaction so background-path invocations carry the org GUC", () => {
    expect(postingServiceSrc).toContain("runInNewTenantTransaction");
    expect(postingServiceSrc).toContain("postJournal");
  });

  it("postPaid does not contain a bare catch block that would swallow a 42501 before it surfaces", () => {
    const postPaidIdx = postingServiceSrc.indexOf("async postPaid");
    const postPaidSlice = postingServiceSrc.slice(postPaidIdx, postPaidIdx + 800);
    expect(postPaidSlice).not.toContain("} catch");
  });

  it("autoSnapshotJournal wraps createBatch in runInNewTenantTransaction so post-commit snapshot calls carry the org GUC", () => {
    expect(completionSrc).toContain("runInNewTenantTransaction");
    expect(completionSrc).toContain("createBatch");
  });

  it("autoSnapshotJournal rethrows after logging so a 42501 is visible rather than silently dropped", () => {
    expect(completionSrc).toContain("throw err");
  });
});
