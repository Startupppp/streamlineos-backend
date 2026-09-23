import { BUILD_MODULES } from "../build.module";
import { ProjectsByIdModule } from "../core/projects-by-id.module";
import { BuildImportExportModule } from "./build-import-export.module";
import { TicketImportExportController } from "./ticket-import-export.controller";

function controllersOf(mod: unknown): unknown[] {
  return (Reflect.getMetadata("controllers", mod as object) as unknown[]) ?? [];
}

describe("BuildImportExportModule registration — the services existed but no route reached them", () => {
  it("is listed in BUILD_MODULES, without which the controller compiles green and does not exist", () => {
    expect(BUILD_MODULES).toContain(BuildImportExportModule);
  });

  it("registers the import-export controller on the module", () => {
    expect(controllersOf(BuildImportExportModule)).toContain(TicketImportExportController);
  });

  it("registers before ProjectsByIdModule, whose bare build/:projectId route would swallow it", () => {
    const importExportAt = BUILD_MODULES.indexOf(BuildImportExportModule);
    const byIdAt = BUILD_MODULES.indexOf(ProjectsByIdModule);
    expect(importExportAt).toBeGreaterThanOrEqual(0);
    expect(byIdAt).toBeGreaterThan(importExportAt);
  });

  it("leaves ProjectsByIdModule last, which is the invariant this insertion could have broken", () => {
    expect(BUILD_MODULES[BUILD_MODULES.length - 1]).toBe(ProjectsByIdModule);
  });
});
