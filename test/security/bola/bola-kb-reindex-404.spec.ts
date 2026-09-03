import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { KbPageIndexingController } from "src/modules/kb/retrieval/kb-page-indexing.controller";
import type { KbIndexingService } from "src/modules/kb/retrieval/kb-indexing.service";
import type { CurrentUserContext } from "src/common/auth/backend-claims";

/**
 * `POST /kb/pages/:pageId/reindex` — found by the live cross-tenant sweep.
 *
 * `KbIndexingService.indexPage` treats a page it cannot find as "nothing to index": it drops any
 * stale chunks and returns 0. That is right for its internal callers — a content event can arrive
 * after the page was deleted — and wrong for a request. The controller ignored the return value and
 * answered 200 `{"reindexed":true}` for another organisation's page id and for an id belonging to
 * no organisation alike. Measured control 200 / cross-tenant 200 / absent 200: nothing crossed,
 * every statement inside is org-bound, but the caller is told a page was reindexed that does not
 * exist and the contract 404 is absent.
 *
 * The request path is now its own method, so the internal tolerance is not weakened to fix the
 * boundary.
 */

const CALLER: CurrentUserContext = { userId: "u", orgId: "org-b-caller", sessionId: "s" } as CurrentUserContext;
const FOREIGN_PAGE_ID = 4242;

function controllerWith(reindexPageOnRequest: jest.Mock): KbPageIndexingController {
  const indexing = { reindexPageOnRequest, indexPage: jest.fn() } as unknown as KbIndexingService;
  return new KbPageIndexingController(indexing);
}

describe("BOLA probe — POST /kb/pages/:pageId/reindex", () => {
  it("CROSS-TENANT-MISS: another organisation's page id is refused", async () => {
    const fn = jest.fn().mockRejectedValue(new NotFoundException("Page not found"));
    await expect(controllerWith(fn).reindexPage(CALLER, FOREIGN_PAGE_ID)).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const fn = jest.fn().mockRejectedValue(new NotFoundException("Page not found"));
    const thrown = await controllerWith(fn)
      .reindexPage(CALLER, FOREIGN_PAGE_ID)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  /**
   * The handler must call the request-path method. Calling `indexPage` again is the whole defect,
   * and a fix that only adds a method nobody calls is the inert shape this release keeps finding.
   */
  it("WIRED: the handler goes through the request path, never the tolerant internal one", async () => {
    const fn = jest.fn().mockResolvedValue(3);
    const indexPage = jest.fn();
    const indexing = { reindexPageOnRequest: fn, indexPage } as unknown as KbIndexingService;
    const controller = new KbPageIndexingController(indexing);
    await expect(controller.reindexPage(CALLER, 7)).resolves.toEqual({ reindexed: true });
    expect(fn).toHaveBeenCalledWith(CALLER.orgId, 7);
    expect(indexPage).not.toHaveBeenCalled();
  });
});
