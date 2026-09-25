import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { documents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import type { ScopedRead } from "../../access/scoped-read";
import { documentReadableScope } from "./documents-helpers";
import { resolveDocumentsManageScope, resolveDocumentsScope } from "./performance-scope";

/** What a caller may DO to the company's documents, as opposed to which rows they may see. */
export type DocumentAction = "view" | "manage" | "publish";

const PUBLISH_PERMISSION = "hr:documents:publish";

/**
 * Everything about one caller that decides document access, read ONCE per request from the auth context and
 * never from a body, query, header or path. Carried by value so no entry point re-derives it and drifts.
 */
export interface DocumentPrincipal {
  readonly orgId: string;
  readonly userId: string;
  readonly membershipId: number | null;
  readonly view: ScopedRead;
  readonly manage: ScopedRead;
  readonly canPublish: boolean;
}

// postgres-js caps bind parameters; a caller asking about more ids than this is not a page of results.
const MAX_IDS_PER_CHECK = 500;

/**
 * The one place that answers "may this caller see this document, and may they act on it?".
 *
 * Before this existed the answer was spread over three mechanisms — the SQL predicate on the read side, an ad
 * hoc `scope.unrestricted` check repeated in every controller, and the write-side judge — and the repetition is
 * exactly what produced V-146: a controller that refused with 403 told a caller who could not see the document
 * at all that its id exists. `assertCanAct` is the single rule: 404 when the caller cannot view the document,
 * 403 reserved for can-view-but-may-not-act.
 */
@Injectable()
export class DocumentAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /** Assemble the principal once per request. One permission resolution feeds both scopes. */
  async principalFor(currentUser: CurrentUserContext): Promise<DocumentPrincipal> {
    const resolved = currentUser.isOrgOwner
      ? undefined
      : await this.access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
    const [view, manage, canPublish] = await Promise.all([
      resolveDocumentsScope(this.access, currentUser, resolved),
      resolveDocumentsManageScope(this.access, currentUser, resolved),
      // Through `holds`, never the resolved map: publish is not scopable, and only `scopeFor` applies the
      // principal's own ceiling, so an agent token that was never granted publish must not inherit it here.
      this.access.holds(currentUser, PUBLISH_PERMISSION),
    ]);
    return {
      orgId: currentUser.orgId,
      userId: currentUser.userId,
      membershipId: actingMembershipId(currentUser.principal),
      view,
      manage,
      canPublish,
    };
  }

  /**
   * Organisation-wide authority over the company's documents. Classification, version history and knowledge-base
   * linking are all company-level, so a caller narrowed to their own (or their team's) rows holds none of it.
   */
  canPerform(principal: DocumentPrincipal, action: DocumentAction): boolean {
    switch (action) {
      case "view":
        return principal.view.unrestricted;
      case "manage":
        return principal.manage.unrestricted;
      case "publish":
        return principal.canPublish;
      default: {
        void (action satisfies never);
        return false;
      }
    }
  }

  /**
   * Which of these documents the caller may read at all — the same scoped predicate the documents list runs,
   * in ONE statement, so this never becomes a per-id loop.
   */
  async filterViewableDocumentIds(
    principal: DocumentPrincipal,
    documentIds: readonly number[],
  ): Promise<Set<number>> {
    const ids = [...new Set(documentIds)].slice(0, MAX_IDS_PER_CHECK);
    if (ids.length === 0) return new Set();
    const rows = await principal.view.read(
      {
        tenant: documents.orgId,
        scope: documentReadableScope(principal.userId, principal.membershipId),
        and: [inArray(documents.id, ids), eq(documents.isActive, true)],
      },
      ({ sql: where }) => this.db.select({ id: documents.id }).from(documents).where(where).limit(ids.length),
      () => [],
    );
    return new Set(rows.map((row) => row.id));
  }

  async canViewDocument(principal: DocumentPrincipal, documentId: number): Promise<boolean> {
    return (await this.filterViewableDocumentIds(principal, [documentId])).has(documentId);
  }

  /**
   * The gate every document route runs. A caller who may not even see the document is told the same thing an
   * id that was never issued is worth: 404, with a message that names nothing.
   */
  async assertCanAct(principal: DocumentPrincipal, documentId: number, action: DocumentAction): Promise<void> {
    if (this.canPerform(principal, action)) return;
    if (!(await this.canViewDocument(principal, documentId))) throw new NotFoundException("Document not found.");
    throw new ForbiddenException("Organization-wide document access is required.");
  }
}
