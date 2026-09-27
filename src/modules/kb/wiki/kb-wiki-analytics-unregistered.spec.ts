import "reflect-metadata";
import { KbWikiModule } from "./kb-wiki.module";
import { KbWikiAnalyticsController } from "../analytics/kb-wiki-analytics.controller";

function controllersOf(mod: unknown): unknown[] {
  return (Reflect.getMetadata("controllers", mod as object) as unknown[]) ?? [];
}

describe("KbWikiAnalyticsController registration — no frontend caller for /kb/wiki/analytics/* routes", () => {
  it("KbWikiAnalyticsController is not registered in KbWikiModule, because it has no frontend caller and adding one requires a consumer in this test", () => {
    expect(controllersOf(KbWikiModule)).not.toContain(KbWikiAnalyticsController);
  });
});
