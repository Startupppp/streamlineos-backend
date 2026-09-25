import { ForbiddenException } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

const ORG_ID = "org-docs-scope";
const DOCUMENT_ID = 7;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-scoped",
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess",
    tokenScopes: null,
    principal: humanSessionPrincipal(20, false),
    ...overrides,
  };
}

/**
 * Rich documents and letters have no owner column (`rich_documents`) or ignore the caller's scope
 * (`listLetters`), so they used to answer any holder of `hr:documents:view` with the whole
 * organisation's rows — experience certificates and offer letters included. They now need scope
 * `all`. Mocks are safe here because the property under test is "the service is not reached".
 */
function build(view: DataScope, manage: DataScope) {
  const richDocuments = {
    list: jest.fn().mockResolvedValue({ data: [] }),
    create: jest.fn().mockResolvedValue({ id: 1 }),
    get: jest.fn().mockResolvedValue({ id: DOCUMENT_ID }),
    update: jest.fn().mockResolvedValue({ success: true }),
    remove: jest.fn().mockResolvedValue({ success: true }),
    togglePublish: jest.fn().mockResolvedValue({ success: true }),
  };
  const letters = {
    listLetters: jest.fn().mockResolvedValue([]),
    renderLetter: jest.fn().mockResolvedValue({}),
    saveLetter: jest.fn().mockResolvedValue({}),
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(
      new Map<string, DataScope>([
        ["hr:documents:view", view],
        ["hr:documents:manage", manage],
      ]),
    ),
  };
  const controller = new DocumentsController(
    {} as never,
    {} as never,
    richDocuments as never,
    letters as never,
    access as never,
    {} as never,
    {} as never,
  );
  return { controller, richDocuments, letters };
}

const reached = (...groups: Record<string, jest.Mock>[]): boolean =>
  groups.some((group) => Object.values(group).some((fn) => fn.mock.calls.length > 0));

type Case = readonly [
  name: string,
  call: (c: DocumentsController, u: CurrentUserContext) => Promise<unknown>,
  needs: "view" | "manage",
];

const CASES: readonly Case[] = [
  ["GET rich-documents", (c, u) => c.listRichDocuments({ limit: 20 } as never, u), "view"],
  ["GET rich-documents/:id", (c, u) => c.getRichDocument(DOCUMENT_ID, u), "view"],
  ["POST rich-documents", (c, u) => c.createRichDocument({ title: "t" } as never, u), "manage"],
  ["PATCH rich-documents/:id", (c, u) => c.updateRichDocument(DOCUMENT_ID, {} as never, u), "manage"],
  ["PATCH rich-documents/:id/publish", (c, u) => c.publishRichDocument(DOCUMENT_ID, u), "manage"],
  ["DELETE rich-documents/:id", (c, u) => c.deleteRichDocument(DOCUMENT_ID, u), "manage"],
  ["GET documents/letters", (c, u) => c.listLetters(undefined, u), "view"],
  ["POST documents/letters/render", (c, u) => c.renderLetter({} as never, u), "manage"],
  ["POST documents/letters", (c, u) => c.saveLetter({} as never, u), "manage"],
];

describe("rich documents and letters need organisation-wide document scope", () => {
  describe.each<DataScope>(["own", "team", "none"])("a caller whose scope is %s", (scope) => {
    it.each(CASES)("is refused on %s and no service is reached", async (_name, call) => {
      const { controller, richDocuments, letters } = build(scope, scope);

      await expect(call(controller, makeUser())).rejects.toBeInstanceOf(ForbiddenException);

      for (const fn of [...Object.values(richDocuments), ...Object.values(letters)])
        expect(fn).not.toHaveBeenCalled();
    });
  });

  it.each(CASES)("lets a caller with scope all through on %s", async (_name, call) => {
    const { controller, richDocuments, letters } = build("all", "all");

    await call(controller, makeUser());

    expect(reached(richDocuments, letters)).toBe(true);
  });

  it.each(CASES)("lets the organisation owner through on %s", async (_name, call) => {
    const { controller, richDocuments, letters } = build("none", "none");

    await call(controller, makeUser({ isOrgOwner: true }));

    expect(reached(richDocuments, letters)).toBe(true);
  });

  it.each(CASES.filter(([, , needs]) => needs === "manage"))(
    "judges %s on the manage key, so view-all alone is not enough to write",
    async (_name, call) => {
      const { controller } = build("all", "own");

      await expect(call(controller, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each(CASES.filter(([, , needs]) => needs === "view"))(
    "judges %s on the view key, so manage-all alone is not enough to read",
    async (_name, call) => {
      const { controller } = build("own", "all");

      await expect(call(controller, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
