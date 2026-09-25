import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { DocumentAccessService } from "./document-access.service";
import { DocumentClassificationController } from "./document-classification.controller";
import { DocumentKbLinkController } from "./document-kb-link.controller";
import { DocumentVersionsController } from "./document-versions.controller";
import { KbLinkedDocumentsController } from "../../kb/linked-documents/kb-linked-documents.controller";

/**
 * V-165. The answer every HR-document and knowledge-base route gives each kind of caller is spread over four
 * controllers, three permission keys, two data scopes and one access service, and the only way to read it was
 * to hold all of that in your head at once. This walks the whole grid — for a document the caller may see AND
 * for one they may not, which is what makes 403 and 404 tell apart — and writes it out as a table.
 *
 * The table is committed at test/snapshots/hr-kb-permission-matrix.md and asserted against, so the matrix can
 * still change, but only on purpose and in a diff a reviewer can read. Regenerate deliberately with
 * `UPDATE_HR_KB_MATRIX=1 npx jest hr-kb-permission-matrix`.
 */

const SNAPSHOT = resolve(__dirname, "../../../../test/snapshots/hr-kb-permission-matrix.md");
const DOCUMENT_ID = 11;
const OTHER_DOCUMENT_ID = 99;

type Grants = Map<string, DataScope>;

interface Caller {
  label: string;
  isOrgOwner: boolean;
  grants: Grants;
}

const grantsOf = (view: DataScope, manage: DataScope, publish: DataScope, kbView: DataScope = "all"): Grants =>
  new Map<string, DataScope>([
    ["hr:documents:view", view],
    ["hr:documents:manage", manage],
    ["hr:documents:publish", publish],
    ["kb:pages:view", kbView],
  ]);

const CALLERS: Caller[] = [
  { label: "org owner", isOrgOwner: true, grants: grantsOf("none", "none", "none") },
  { label: "HR admin (view/manage/publish, all)", isOrgOwner: false, grants: grantsOf("all", "all", "all") },
  { label: "HR viewer (view all)", isOrgOwner: false, grants: grantsOf("all", "none", "none") },
  { label: "HR editor (view+manage all, no publish)", isOrgOwner: false, grants: grantsOf("all", "all", "none") },
  { label: "manager (view team)", isOrgOwner: false, grants: grantsOf("team", "none", "none") },
  { label: "employee (view own)", isOrgOwner: false, grants: grantsOf("own", "none", "none") },
  { label: "no HR access (KB reader only)", isOrgOwner: false, grants: grantsOf("none", "none", "none") },
];

function makeUser(caller: Caller): CurrentUserContext {
  return {
    userId: "user-matrix",
    orgId: "org-matrix",
    role: caller.isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner: caller.isOrgOwner,
    sessionId: "sess",
    tokenScopes: null,
    principal: humanSessionPrincipal(31, false),
  };
}

/** The real access service over a database double answering with the ids this caller may read. */
function documentAccessFor(grants: Grants, visibleIds: readonly number[]): DocumentAccessService {
  const builder: { from: jest.Mock; where: jest.Mock; limit: jest.Mock } = {
    from: jest.fn(() => builder),
    where: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(visibleIds.map((id) => ({ id })))),
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(grants),
    holds: jest.fn(async (_user: CurrentUserContext, key: string) => (grants.get(key) ?? "none") !== "none"),
  };
  return new DocumentAccessService({ select: jest.fn(() => builder) } as never, access as never);
}

const ok = () => jest.fn().mockResolvedValue({ ok: true });

interface Route {
  label: string;
  handler: (...args: never[]) => unknown;
  /** Invokes the route, with the access service built over the ids this caller may read. */
  call: (access: DocumentAccessService, user: CurrentUserContext, documentId: number) => Promise<unknown>;
}

const ROUTES: Route[] = [
  {
    label: "GET /hr/documents/:id/classification",
    handler: DocumentClassificationController.prototype.get,
    call: (access, user, id) =>
      new DocumentClassificationController({ get: ok(), classify: ok(), setAudiences: ok() } as never, access).get(id, user),
  },
  {
    label: "PATCH /hr/documents/:id/classification",
    handler: DocumentClassificationController.prototype.classify,
    call: (access, user, id) =>
      new DocumentClassificationController({ get: ok(), classify: ok(), setAudiences: ok() } as never, access).classify(
        id,
        { classification: "INTERNAL" },
        user,
      ),
  },
  {
    label: "PUT /hr/documents/:id/audiences",
    handler: DocumentClassificationController.prototype.setAudiences,
    call: (access, user, id) =>
      new DocumentClassificationController({ get: ok(), classify: ok(), setAudiences: ok() } as never, access).setAudiences(
        id,
        { audiences: [] },
        user,
      ),
  },
  {
    label: "GET /hr/documents/:id/versions",
    handler: DocumentVersionsController.prototype.list,
    call: (access, user, id) => new DocumentVersionsController({ list: ok(), upload: ok(), approve: ok() } as never, access).list(id, user),
  },
  {
    label: "POST /hr/documents/:id/versions",
    handler: DocumentVersionsController.prototype.upload,
    call: (access, user, id) =>
      new DocumentVersionsController({ list: ok(), upload: ok(), approve: ok() } as never, access).upload(id, { fileUrl: "k" }, user),
  },
  {
    label: "POST /hr/documents/:id/versions/:n/approve",
    handler: DocumentVersionsController.prototype.approve,
    call: (access, user, id) => new DocumentVersionsController({ list: ok(), upload: ok(), approve: ok() } as never, access).approve(id, 2, user),
  },
  {
    label: "GET /hr/documents/:id/kb-link",
    handler: DocumentKbLinkController.prototype.state,
    call: (access, user, id) => new DocumentKbLinkController(kbLinks(), {} as never, access).state(id, user),
  },
  {
    label: "POST /hr/documents/:id/kb-link",
    handler: DocumentKbLinkController.prototype.publish,
    call: (access, user, id) => new DocumentKbLinkController(kbLinks(), {} as never, access).publish(id, {}, user),
  },
  {
    label: "DELETE /hr/documents/:id/kb-link",
    handler: DocumentKbLinkController.prototype.unpublish,
    call: (access, user, id) => new DocumentKbLinkController(kbLinks(), {} as never, access).unpublish(id, {}, user),
  },
  {
    label: "GET /kb/linked-documents",
    handler: KbLinkedDocumentsController.prototype.list,
    call: (access, user) => new KbLinkedDocumentsController(flagsOn(), kbQuery(), kbFiles(), access).list({ limit: 30 }, user),
  },
  {
    label: "POST /kb/linked-documents/:id/open",
    handler: KbLinkedDocumentsController.prototype.open,
    call: (access, user, id) => new KbLinkedDocumentsController(flagsOn(), kbQuery(), kbFiles(), access).open(id, user),
  },
];

const kbLinks = () => ({ getState: ok(), publish: ok(), updateLink: ok(), unpublish: ok() }) as never;
const flagsOn = () => ({ assertEnabled: jest.fn().mockResolvedValue(undefined) }) as never;
const kbQuery = () => ({ list: jest.fn().mockResolvedValue({ data: [] }), get: ok() }) as never;
const kbFiles = () => ({ open: ok() }) as never;

/** What the caller actually gets, as a request would produce it: the guard first, then the service. */
async function outcome(route: Route, caller: Caller, visibleIds: readonly number[]): Promise<string> {
  const required = new Reflector().get<string | undefined>(REQUIRE_PERMISSION, route.handler);
  // PermissionGuard runs before the handler, and the org owner passes it whatever the grants say.
  if (required !== undefined && !caller.isOrgOwner && (caller.grants.get(required) ?? "none") === "none") return "403 guard";

  const documentId = visibleIds.includes(DOCUMENT_ID) ? DOCUMENT_ID : OTHER_DOCUMENT_ID;
  try {
    await route.call(documentAccessFor(caller.grants, visibleIds), makeUser(caller), documentId);
    return "allowed";
  } catch (error) {
    if (error instanceof NotFoundException) return "404";
    if (error instanceof ForbiddenException) return "403";
    return `error: ${(error as Error).constructor.name}`;
  }
}

function table(title: string, rows: string[][], header: string[]): string {
  const lines = [`### ${title}`, "", `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

async function renderMatrix(): Promise<string> {
  const header = ["caller", ...ROUTES.map((route) => route.label)];
  const sections: string[] = [];
  for (const [title, visibleIds] of [
    ["A document the caller may see", [DOCUMENT_ID]],
    ["A document the caller may NOT see (another employee's)", []],
  ] as const) {
    const rows: string[][] = [];
    for (const caller of CALLERS) {
      const cells: string[] = [];
      for (const route of ROUTES) cells.push(await outcome(route, caller, visibleIds));
      rows.push([caller.label, ...cells]);
    }
    sections.push(table(title, rows, header));
  }
  return [
    "# HR documents in the knowledge base — resolved permission matrix",
    "",
    "GENERATED by src/modules/hr/performance/hr-kb-permission-matrix.spec.ts. Do not hand-edit:",
    "the spec asserts against this file, and regenerating it is `UPDATE_HR_KB_MATRIX=1 npx jest hr-kb-permission-matrix`.",
    "",
    "`403 guard` is PermissionGuard refusing before the handler runs; `403` is the handler's own refusal",
    "(the caller can see the document but may not act on it); `404` is the caller being told the document",
    "does not exist, which is what they are told about a document they cannot see at all.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

describe("the HR-document / knowledge-base permission matrix", () => {
  it("matches the committed table, so it can only change on purpose", async () => {
    const rendered = await renderMatrix();

    if (process.env.UPDATE_HR_KB_MATRIX === "1") {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, rendered, "utf8");
    }

    const committed = readFileSync(SNAPSHOT, "utf8");
    expect(rendered).toBe(committed);
  });

  it("the table really distinguishes the three answers, so matching it means something", async () => {
    const rendered = await renderMatrix();

    // If every cell said the same thing the assertion above would still pass, and say nothing.
    expect(rendered).toContain("| allowed |");
    expect(rendered).toContain("403 guard");
    expect(rendered).toContain("| 404 ");
    expect(rendered).toContain("| 403 |");
  });

  it("a scoped caller is told 404, never 403, about a document they cannot see", async () => {
    const employee = CALLERS.find((caller) => caller.label.startsWith("employee"));
    expect(employee).toBeDefined();

    const answers = await Promise.all(ROUTES.map(async (route) => outcome(route, employee!, [])));

    expect(answers).not.toContain("403");
  });
});
