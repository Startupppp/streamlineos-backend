import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { DocumentAccessService } from "./document-access.service";
import { DocumentClassificationController } from "./document-classification.controller";
import { DocumentKbLinkController } from "./document-kb-link.controller";
import { DocumentVersionsController } from "./document-versions.controller";

const ORG_ID = "org-document-access";
const MY_DOCUMENT = 7;
const SOMEONE_ELSES_DOCUMENT = 99;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-hr",
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess",
    tokenScopes: null,
    principal: humanSessionPrincipal(31, false),
    ...overrides,
  };
}

/**
 * The database stands in for the scoped predicate: it answers with exactly the ids this caller may read. What
 * the spec pins is that every entry point routes through it and agrees, not what the SQL text is — the SQL is
 * the documents list's own predicate, exercised against a real database by the .db specs.
 */
function makeDb(visibleIds: readonly number[]) {
  const select = jest.fn();
  const builder: { from: jest.Mock; where: jest.Mock; limit: jest.Mock } = {
    from: jest.fn(() => builder),
    where: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(visibleIds.map((id) => ({ id })))),
  };
  select.mockReturnValue(builder);
  return { db: { select } as unknown as Db, select };
}

function build(scopes: { view: DataScope; manage: DataScope; publish: DataScope }, visibleIds: readonly number[] = []) {
  const grants = new Map<string, DataScope>([
    ["hr:documents:view", scopes.view],
    ["hr:documents:manage", scopes.manage],
    ["hr:documents:publish", scopes.publish],
  ]);
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(grants),
    holds: jest.fn(async (_user: CurrentUserContext, key: string) => (grants.get(key) ?? "none") !== "none"),
    scopeFor: jest.fn(async (_user: CurrentUserContext, key: string) => grants.get(key) ?? "none"),
  };
  const { db, select } = makeDb(visibleIds);
  return { service: new DocumentAccessService(db, access as never), access, select };
}

describe("document access service", () => {
  describe("canPerform", () => {
    it("grants organisation-wide authority only to a caller whose scope really is organisation-wide", async () => {
      const wide = build({ view: "all", manage: "all", publish: "all" });
      const narrow = build({ view: "team", manage: "own", publish: "none" });

      const widePrincipal = await wide.service.principalFor(makeUser());
      const narrowPrincipal = await narrow.service.principalFor(makeUser());

      expect([
        wide.service.canPerform(widePrincipal, "view"),
        wide.service.canPerform(widePrincipal, "manage"),
        wide.service.canPerform(widePrincipal, "publish"),
      ]).toEqual([true, true, true]);
      expect([
        narrow.service.canPerform(narrowPrincipal, "view"),
        narrow.service.canPerform(narrowPrincipal, "manage"),
        narrow.service.canPerform(narrowPrincipal, "publish"),
      ]).toEqual([false, false, false]);
    });

    it("reads publish through the principal's own ceiling, not the raw grant map", async () => {
      const { service, access } = build({ view: "none", manage: "none", publish: "all" });

      const principal = await service.principalFor(makeUser());

      expect(service.canPerform(principal, "publish")).toBe(true);
      expect(access.holds).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-hr" }), "hr:documents:publish");
    });

    it("takes the tenant and the actor from the session and from nothing else", async () => {
      const { service } = build({ view: "own", manage: "none", publish: "none" });

      const principal = await service.principalFor(makeUser());

      expect({ orgId: principal.orgId, userId: principal.userId, membershipId: principal.membershipId }).toEqual({
        orgId: ORG_ID,
        userId: "user-hr",
        membershipId: 31,
      });
    });
  });

  describe("filterViewableDocumentIds", () => {
    it("keeps only the ids the scoped read returns", async () => {
      const { service } = build({ view: "own", manage: "none", publish: "none" }, [MY_DOCUMENT]);

      const visible = await service.filterViewableDocumentIds(
        await service.principalFor(makeUser()),
        [MY_DOCUMENT, SOMEONE_ELSES_DOCUMENT],
      );

      expect([...visible]).toEqual([MY_DOCUMENT]);
    });

    it("asks the database once for a page of ids, never once per id", async () => {
      const { service, select } = build({ view: "team", manage: "none", publish: "none" }, [1, 2, 3]);

      await service.filterViewableDocumentIds(await service.principalFor(makeUser()), [1, 2, 3, 3, 4]);

      expect(select).toHaveBeenCalledTimes(1);
    });

    it("answers nothing for a denied scope without reaching the database at all", async () => {
      const { service, select } = build({ view: "none", manage: "none", publish: "none" }, [MY_DOCUMENT]);

      const visible = await service.filterViewableDocumentIds(await service.principalFor(makeUser()), [MY_DOCUMENT]);

      expect([...visible]).toEqual([]);
      expect(select).not.toHaveBeenCalled();
    });

    it("returns an empty set for an empty request without reaching the database", async () => {
      const { service, select } = build({ view: "all", manage: "all", publish: "all" }, [MY_DOCUMENT]);

      expect([...(await service.filterViewableDocumentIds(await service.principalFor(makeUser()), []))]).toEqual([]);
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe("canViewDocument", () => {
    it("is true for a document the scoped read returns and false for one it does not", async () => {
      const { service } = build({ view: "own", manage: "none", publish: "none" }, [MY_DOCUMENT]);
      const principal = await service.principalFor(makeUser());

      expect(await service.canViewDocument(principal, MY_DOCUMENT)).toBe(true);
      expect(await service.canViewDocument(principal, SOMEONE_ELSES_DOCUMENT)).toBe(false);
    });
  });

  describe("assertCanAct", () => {
    it("says nothing exists when the caller cannot even view the document", async () => {
      const { service } = build({ view: "own", manage: "own", publish: "none" }, []);

      await expect(
        service.assertCanAct(await service.principalFor(makeUser()), SOMEONE_ELSES_DOCUMENT, "manage"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses with 403 only when the caller can see the document but may not act on it", async () => {
      const { service } = build({ view: "own", manage: "own", publish: "none" }, [MY_DOCUMENT]);

      await expect(
        service.assertCanAct(await service.principalFor(makeUser()), MY_DOCUMENT, "manage"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("lets an organisation-wide caller through without a visibility query", async () => {
      const { service, select } = build({ view: "all", manage: "all", publish: "all" });

      await expect(
        service.assertCanAct(await service.principalFor(makeUser()), SOMEONE_ELSES_DOCUMENT, "manage"),
      ).resolves.toBeUndefined();
      expect(select).not.toHaveBeenCalled();
    });
  });

  /**
   * V-145/V-146 together: before the service existed each controller carried its own `scope.unrestricted` check
   * and answered 403, which told a caller who could not see the document at all that its id was real.
   */
  describe("every document entry point gives one caller one answer", () => {
    const entryPoints: ReadonlyArray<[string, (service: DocumentAccessService, user: CurrentUserContext) => Promise<unknown>]> = [
      [
        "GET /hr/documents/:id/classification",
        (service, user) => new DocumentClassificationController({ get: jest.fn() } as never, service).get(SOMEONE_ELSES_DOCUMENT, user),
      ],
      [
        "PATCH /hr/documents/:id/classification",
        (service, user) =>
          new DocumentClassificationController({ classify: jest.fn() } as never, service).classify(
            SOMEONE_ELSES_DOCUMENT,
            { classification: "INTERNAL" },
            user,
          ),
      ],
      [
        "GET /hr/documents/:id/kb-link",
        (service, user) => new DocumentKbLinkController({ getState: jest.fn() } as never, {} as never, service).state(SOMEONE_ELSES_DOCUMENT, user),
      ],
      [
        "GET /hr/documents/:id/versions",
        (service, user) => new DocumentVersionsController({ list: jest.fn() } as never, service).list(SOMEONE_ELSES_DOCUMENT, user),
      ],
    ];

    it.each(entryPoints)("%s answers 404, not 403, to a caller who cannot view the document", async (_route, call) => {
      const { service } = build({ view: "own", manage: "own", publish: "none" }, []);

      const error = await call(service, makeUser()).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(JSON.stringify((error as NotFoundException).getResponse())).not.toContain(String(SOMEONE_ELSES_DOCUMENT));
    });

    it("lets the organisation owner through every one of them", async () => {
      const owner = makeUser({ isOrgOwner: true });
      for (const [, call] of entryPoints) {
        const { service } = build({ view: "none", manage: "none", publish: "none" });
        await expect(call(service, owner)).resolves.not.toThrow();
      }
    });
  });
});
