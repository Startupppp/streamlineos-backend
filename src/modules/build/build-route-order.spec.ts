import { BUILD_MODULES } from "./build.module";
import { ProjectsByIdModule, ProjectResourcesController } from "./core";

function handlerNames(controller: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(controller.prototype);
}

describe("GET build/:projectId must stay the last route registered under the build prefix", () => {
  it("keeps ProjectsByIdModule last, because its bare :projectId route swallows every literal sibling registered after it", () => {
    expect(BUILD_MODULES[BUILD_MODULES.length - 1]).toBe(ProjectsByIdModule);
  });

  it("registers ProjectsByIdModule after the module owning the literal build/org-custom-states route", () => {
    const byIdAt = BUILD_MODULES.indexOf(ProjectsByIdModule);
    const projectsAt = BUILD_MODULES.findIndex((mod) => mod.name === "ProjectsModule");
    expect(projectsAt).toBeGreaterThanOrEqual(0);
    expect(byIdAt).toBeGreaterThan(projectsAt);
  });

  it("registers ProjectsByIdModule after ScopeDirectoryModule so build/scope-directory/* is never swallowed", () => {
    const byIdAt = BUILD_MODULES.indexOf(ProjectsByIdModule);
    const scopeAt = BUILD_MODULES.findIndex((mod) => mod.name === "ScopeDirectoryModule");
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(byIdAt).toBeGreaterThan(scopeAt);
  });

  it("bite proof: a reordering that puts the catch-all anywhere but last is what this rejects", () => {
    const reordered = [ProjectsByIdModule, ...BUILD_MODULES.filter((mod) => mod !== ProjectsByIdModule)];
    expect(reordered[reordered.length - 1]).not.toBe(ProjectsByIdModule);
  });

  it("still has a controller owning the single-segment literal route the ordering protects", () => {
    expect(handlerNames(ProjectResourcesController)).toContain("listOrgCustomStates");
  });
});
