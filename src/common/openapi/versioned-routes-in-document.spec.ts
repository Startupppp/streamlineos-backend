/**
 * Two live routes appeared in no OpenAPI document, so every contract gate ran
 * over a surface that did not include them.
 *
 * `main.ts:85-88` enables `VersioningType.URI`, and `users.controller.ts:68`
 * (`listUsersV2`) and `:259` (`getUserV2`) carry `@Version(API_VERSION_NEXT)`,
 * so `/v2/users` and `/v2/users/{userId}` are served. `openapi.json` contains no
 * path beginning `/v2`: `src/scripts/generate-openapi.ts` — the script that
 * writes the vendored artifact — builds the application with
 * `NestFactory.create(AppModule, …)` and never calls `enableVersioning`, so
 * `@nestjs/swagger`'s explorer reads `applicationConfig.getVersioning()` as
 * undefined and emits the unversioned path only.
 *
 * The consequence is not cosmetic. `check:contract-registry` prints "all 3656
 * operations are classified" and `check:contract-breaking-change` prints "no
 * breaking changes detected" over a document missing the two routes that serve
 * the user directory — the frontend reaches them from `hooks/api/users/queries.ts`
 * into `users-page.tsx`, `user-detail-sheet.tsx`,
 * `directory/people/person-modules-tab.tsx` and `person-membership-tab.tsx`.
 * Renaming a field on `toUserIdentity` would break four screens with both gates
 * green.
 *
 * `configureApiVersioning` exists so the document build and the running
 * application cannot drift apart again, and this spec is what holds it: it
 * builds a document from a controller carrying `@Version` and requires the
 * versioned path to be present.
 */
import { Controller, Get, Version } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { API_VERSION_NEXT } from "../http/api-version";
import { configureApiVersioning } from "./configure-api-versioning";

@Controller("widgets")
class WidgetsController {
  @Get()
  list(): string[] {
    return [];
  }

  @Version(API_VERSION_NEXT)
  @Get()
  listV2(): string[] {
    return [];
  }

  @Version(API_VERSION_NEXT)
  @Get(":widgetId")
  getV2(): string {
    return "";
  }
}

async function buildPaths(withVersioning: boolean): Promise<string[]> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WidgetsController],
  }).compile();
  const app = moduleRef.createNestApplication();
  if (withVersioning) configureApiVersioning(app);
  await app.init();

  const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  const paths = Object.keys(document.paths);
  await app.close();
  return paths;
}

describe("the OpenAPI document covers versioned routes", () => {
  it("emits the /v{n} path for a handler carrying @Version", async () => {
    const paths = await buildPaths(true);

    expect(paths).toContain("/v2/widgets");
    expect(paths).toContain("/v2/widgets/{widgetId}");
  });

  it("leaves an unversioned handler at its unversioned path", async () => {
    const paths = await buildPaths(true);

    expect(paths).toContain("/widgets");
  });

  it("BITE: without the versioning configuration the versioned paths vanish", async () => {
    const paths = await buildPaths(false);

    // Exactly the state that shipped: the v2 handlers collapse onto the
    // unversioned path and no /v2 route is documented at all.
    expect(paths.some((path) => path.startsWith("/v2"))).toBe(false);
    expect(paths).toContain("/widgets");
  });
});
