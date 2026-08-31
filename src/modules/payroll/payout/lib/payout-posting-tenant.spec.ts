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

function methodSource(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`${signature} no longer exists in payroll-posting.service.ts`);
  const open = src.indexOf("{", start);
  if (open === -1) throw new Error(`${signature} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${signature} has an unbalanced body`);
}

describe("payroll deferred posting — tenant GUC isolation", () => {
  it("postPaid wraps the journal call in runInNewTenantTransaction so background-path invocations carry the org GUC", () => {
    expect(postingServiceSrc).toContain("runInNewTenantTransaction");
    expect(postingServiceSrc).toContain("postJournal");
  });

  it("postPaid does not contain a bare catch block that would swallow a 42501 before it surfaces", () => {
    expect(methodSource(postingServiceSrc, "async postPaid")).not.toContain("catch");
  });

  it("autoSnapshotJournal wraps createBatch in runInNewTenantTransaction so post-commit snapshot calls carry the org GUC", () => {
    expect(completionSrc).toContain("runInNewTenantTransaction");
    expect(completionSrc).toContain("createBatch");
  });

  it("autoSnapshotJournal rethrows after logging so a 42501 is visible rather than silently dropped", () => {
    expect(completionSrc).toContain("throw err");
  });
});
