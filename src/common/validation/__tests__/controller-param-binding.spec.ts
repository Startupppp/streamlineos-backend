import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

/**
 * PRD-C048 — every path parameter reaches a handler through a validation boundary.
 *
 * `@Validate({ body })` was applied almost everywhere and `check:body-binding` reports
 * 0 unbound bodies, but the PARAM half had no gate at all, so eight bindings across
 * three controllers took a raw path segment with neither a pipe nor a
 * `@Validate({ params })`: `platform-operator-access.controller.ts` bound a Postgres
 * `uuid` column as free text (an invalid segment failed `22P02` inside the query
 * instead of 400 at the boundary), `gdpr.controller.ts` handed an unchecked id to the
 * export and erasure services, and `public.controller.ts` did it on two
 * UNAUTHENTICATED routes.
 *
 * The assertion is zero, not a ratchet: the repository is at zero now, so anything
 * above zero is a new defect rather than inherited debt. A pipe (`ParseIntPipe` and
 * friends) counts as a boundary — it rejects before the handler body runs.
 *
 * The query half is asserted only over the two controllers this ticket fixed. 40 raw
 * `@Query("x")` bindings remain elsewhere, owned by other module lanes; pinning them
 * here would be claiming their work.
 */

const BACKEND_ROOT = resolve(__dirname, "..", "..", "..", "..");

function controllerFiles(directory = "src"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(BACKEND_ROOT, directory), { withFileTypes: true })) {
    const file = posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...controllerFiles(file));
    } else if (entry.name.endsWith(".controller.ts") && !entry.name.endsWith(".spec.ts")) {
      files.push(file);
    }
  }
  return files;
}

/**
 * The decorator block + signature for the handler that owns line `index`, found by
 * walking back to the previous method's closing brace at class-member indentation.
 */
function handlerWindow(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && !/^ {2}\}/.test(lines[start - 1] ?? "")) start--;
  return lines.slice(start, index + 1).join("\n");
}

interface Site {
  file: string;
  line: number;
  text: string;
}

function unvalidatedBindings(files: string[], kind: "Param" | "Query"): Site[] {
  const decorator = new RegExp(`@${kind}\\(\\s*"([^"]+)"\\s*(,)?`);
  const key = kind === "Param" ? "params" : "query";
  const sites: Site[] = [];
  for (const file of files) {
    const lines = readFileSync(join(BACKEND_ROOT, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = decorator.exec(lines[i] ?? "");
      if (!match) continue;
      // A pipe is a boundary in its own right: it rejects before the handler runs.
      if (match[2] === ",") continue;
      const window = handlerWindow(lines, i);
      const validate = /@Validate\(\{[\s\S]*?\}\)/.exec(window);
      if (validate && new RegExp(`\\b${key}\\s*:`).test(validate[0])) continue;
      sites.push({ file, line: i + 1, text: (lines[i] ?? "").trim() });
    }
  }
  return sites;
}

describe("PRD-C048 — path parameters cross a validation boundary", () => {
  const files = controllerFiles();

  it("scans a real controller corpus", () => {
    // Anti-vacuity: a broken walk or a moved root would make every assertion below pass.
    expect(files.length).toBeGreaterThan(400);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((file) => file.startsWith("src/") && file.endsWith(".controller.ts"))).toBe(true);
    expect(files.some((file) => file.includes("\\") || file.endsWith(".spec.ts"))).toBe(false);
    expect(controllerFiles()).toEqual(files);
  });

  it("no @Param binding lacks both a pipe and @Validate({ params })", () => {
    const sites = unvalidatedBindings(files, "Param");
    expect(sites.map((site) => `${site.file}:${String(site.line)}  ${site.text}`)).toEqual([]);
  });

  it("detects an unvalidated binding when one exists", () => {
    // The detector itself is exercised, so "zero findings" cannot mean "finds nothing".
    const lines = [
      "  @Get(\"thing/:thingId\")",
      "  getThing(",
      "    @Param(\"thingId\") thingId: string,",
      "  ) {",
      "    return thingId;",
      "  }",
    ];
    const window = handlerWindow(lines, 2);
    expect(/@Validate\(/.test(window)).toBe(false);
  });
});

describe("PRD-C048 — the HR automations list routes bind their query through Zod", () => {
  const HR_FILES = [
    "src/modules/hr/automations/hr-webhooks.controller.ts",
    "src/modules/hr/automations/hr-automations.controller.ts",
  ];

  it("no raw keyed @Query survives in either controller", () => {
    const sites = unvalidatedBindings(HR_FILES, "Query");
    expect(sites.map((site) => `${site.file}:${String(site.line)}  ${site.text}`)).toEqual([]);
  });

  it("neither controller clamps a page size by hand any more", () => {
    for (const file of HR_FILES) {
      const source = readFileSync(join(BACKEND_ROOT, file), "utf8");
      // A hand-rolled clamp is invisible to @Validate, so the cap never reaches openapi.json.
      expect([file, /Math\.min\(\s*100\s*,/.test(source)]).toEqual([file, false]);
      expect([file, source.includes("parseInt(")]).toEqual([file, false]);
      expect([file, source.includes("pageSizeField")]).toEqual([file, false]);
    }
  });

  it("the list schemas declare the page-size cap that reaches the document", () => {
    for (const dto of [
      "src/modules/hr/automations/dto/hr-webhook.schemas.ts",
      "src/modules/hr/automations/dto/hr-automation.schemas.ts",
    ]) {
      const source = readFileSync(join(BACKEND_ROOT, dto), "utf8");
      expect([dto, source.includes("pageSizeField(50, 100)")]).toEqual([dto, true]);
    }
  });
});
