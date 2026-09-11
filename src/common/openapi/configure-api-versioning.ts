import { VERSION_NEUTRAL, VersioningType, type INestApplication } from "@nestjs/common";
import { API_VERSION_CURRENT } from "../http/api-version";

/**
 * One place that decides how routes are versioned, applied by the running
 * application AND by the script that writes `openapi.json`.
 *
 * `main.ts` called `enableVersioning` and `src/scripts/generate-openapi.ts` did
 * not. `@nestjs/swagger`'s explorer reads `applicationConfig.getVersioning()`,
 * so with versioning unconfigured every `@Version` handler collapsed onto its
 * unversioned path and no `/v{n}` route reached the document. `GET /v2/users`
 * and `GET /v2/users/{userId}` are served in production, are read by four
 * frontend screens, and appeared in no contract document — so
 * `check:contract-registry` and `check:contract-breaking-change` could both
 * report green over a surface that did not contain them.
 *
 * `defaultVersion` is `VERSION_NEUTRAL` for the document. At runtime `main.ts`
 * passes `[API_VERSION_CURRENT, VERSION_NEUTRAL]`, which makes the current
 * version an ALIAS — `/users` and `/v1/users` route to the same handler.
 * Documenting both would double every operation in `openapi.json`: ~3,600
 * duplicate entries whose only difference is a prefix, on a document whose
 * canonical URL is the unprefixed one every client actually calls. So the
 * document carries each route once, at its canonical path, plus a genuine entry
 * for anything explicitly versioned forward.
 *
 * Pass `runtimeAliases: true` for the serving application, which needs the `/v1`
 * alias so a client that pinned the prefix keeps working.
 */
export function configureApiVersioning(
  app: INestApplication,
  options: { runtimeAliases?: boolean } = {},
): void {
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: options.runtimeAliases
      ? [API_VERSION_CURRENT, VERSION_NEUTRAL]
      : VERSION_NEUTRAL,
  });
}
