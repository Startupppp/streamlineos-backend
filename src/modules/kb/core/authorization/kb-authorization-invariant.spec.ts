import * as fs from "node:fs";
import * as path from "node:path";

const KB_SRC = path.resolve(__dirname, "../..");

function productionSources(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...productionSources(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".e2e-spec.ts") &&
      !entry.name.endsWith(".db.spec.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

function allKbSources(): string[] {
  return productionSources(KB_SRC);
}

function readSrc(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("KB authorization invariant — canonical KnowledgeAuthorization is the only access decision; no caller rebuilds the predicate", () => {
  it("direct callers of buildArticleRestrictionBranch across all KB production files are bounded to the known set — a text scan that catches direct-import call sites but misses barrel re-exports and dynamic imports", () => {
    const KNOWN_CALLERS = [
      "core/authorization/knowledge-authorization.service.ts",
      "core/authorization/knowledge-page-scope.ts",
      "core/kb-support-documents.ts",
      "core/kb-document-delivery-access.ts",
    ];

    const callers = allKbSources()
      .filter((file) => /\bbuildArticleRestrictionBranch\b/.test(readSrc(file)))
      .map((file) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(callers.filter((f) => !KNOWN_CALLERS.includes(f))).toHaveLength(0);
    expect(callers).toEqual(expect.arrayContaining(KNOWN_CALLERS));
  });

  it("no production file inside the retrieval module calls buildArticleRestrictionBranch directly — every article restriction decision must go through articleRestrictionPredicate so the admin null-return is always honoured", () => {
    const retrievalDir = path.join(KB_SRC, "retrieval");
    const callers = productionSources(retrievalDir)
      .filter((file) => /\bbuildArticleRestrictionBranch\b/.test(readSrc(file)))
      .map((file) => path.basename(file));

    expect(callers).toHaveLength(0);
  });

  it("kbPageRestrictions is imported only inside the canonical authorization module — any other production file that imports it has bypassed the restriction predicate builder and is writing an independent access decision", () => {
    const canonicalScopePath = path
      .join(KB_SRC, "core", "authorization", "knowledge-page-scope.ts")
      .split(path.sep)
      .join("/");

    const violators = allKbSources()
      .filter(
        (file) =>
          file.split(path.sep).join("/") !== canonicalScopePath &&
          readSrc(file).includes("kbPageRestrictions"),
      )
      .map((file) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(violators).toHaveLength(0);
  });

  it("POSITIVE CONTROL for kbPageRestrictions guard — the canonical scope module does import kbPageRestrictions, so the guard above is not vacuous", () => {
    const canonicalSrc = readSrc(
      path.join(KB_SRC, "core", "authorization", "knowledge-page-scope.ts"),
    );
    expect(canonicalSrc).toContain("kbPageRestrictions");
  });
});
