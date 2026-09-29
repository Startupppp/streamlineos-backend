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
});
