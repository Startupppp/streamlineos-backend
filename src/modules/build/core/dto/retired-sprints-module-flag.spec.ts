import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectSchema } from "./project-core.schemas";

const base = { name: "Project", modules: { epics: true, timeTracking: true, wiki: true } };

describe("the retired modules.sprints flag stays accepted and stays stored until every pre-retirement frontend bundle has aged out", () => {
  it("keeps the flag on the parsed payload when an old bundle sends it, so the project that bundle just created still parses in that bundle", () => {
    const parsed = createProjectSchema.parse({
      ...base,
      modules: { ...base.modules, sprints: true },
    });
    expect(parsed.modules).toEqual({
      sprints: true,
      epics: true,
      timeTracking: true,
      wiki: true,
    });
  });

  it("accepts a payload from a bundle that has already stopped sending it (positive pair)", () => {
    const parsed = createProjectSchema.parse(base);
    expect(parsed.modules).toEqual({ epics: true, timeTracking: true, wiki: true });
  });

  it("keeps both provisioning defaults until the old-bundle compatibility gate is deliberately removed", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../project-crud/projects-provision.service.ts",
      ),
      "utf8",
    );
    const defaults = source.match(
      /modules:\s*(?:input\.modules\s*\?\?\s*)?\{\s*sprints:\s*true,/g,
    );

    expect(defaults).toHaveLength(2);
  });

  it("keeps the iteration-settings fallback compatible with the same legacy shape", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../settings/projects-settings-iterations.service.ts",
      ),
      "utf8",
    );

    expect(source).toMatch(/modules:\s*\{\s*sprints:\s*false,/);
  });
});
