import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { KbHelpCentreModule } from "./kb-help-centre.module";
import { KbArticlesController } from "./kb-articles.controller";
import { KbCategoriesController } from "./kb-categories.controller";
import { KbCommentsController } from "./kb-comments.controller";
import { KbAuthoringController } from "./kb-authoring.controller";
import { KbVerificationController } from "./kb-verification.controller";

const registeredControllers: unknown[] = Array.isArray(
  Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, KbHelpCentreModule),
)
  ? (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, KbHelpCentreModule) as unknown[])
  : [];

describe("KbHelpCentreModule — retired controllers must not be re-registered", () => {
  it(
    "KbArticlesController is unregistered: /kb/articles/* routes are dead because " +
      "support/core already serves kbPages via /support/kb/* and the help-centre UI " +
      "imports exclusively from @/hooks/api/support/kb*",
    () => {
      expect(registeredControllers).not.toContain(KbArticlesController);
    },
  );

  it(
    "KbCategoriesController is unregistered: /kb/spaces/:id/categories and " +
      "/kb/categories/:id routes are dead because support/core already serves " +
      "kbCategories via /support/kb/categories",
    () => {
      expect(registeredControllers).not.toContain(KbCategoriesController);
    },
  );

  it(
    "KbCommentsController is unregistered: /kb/articles/:id/comments routes are " +
      "dead because support/core already serves kbPageComments via " +
      "/support/kb/articles/:id/comments",
    () => {
      expect(registeredControllers).not.toContain(KbCommentsController);
    },
  );

  it(
    "KbAuthoringController is unregistered: /kb/ai/draft, /kb/ai/improve, " +
      "/kb/ai/summarize have no frontend caller — the wiki module owns AI-assisted " +
      "page authoring and the help-centre articles UI is served by support/core",
    () => {
      expect(registeredControllers).not.toContain(KbAuthoringController);
    },
  );

  it(
    "KbVerificationController is unregistered: /kb/verification/queue has no " +
      "frontend caller and no cross-module consumer",
    () => {
      expect(registeredControllers).not.toContain(KbVerificationController);
    },
  );
});
