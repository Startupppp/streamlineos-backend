import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import type { KbContextPassage } from "../retrieval/kb-ask-context";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";
import type { LinkedDocumentItem } from "./dto/kb-linked-documents-response.schemas";

export const KB_ASK_MAX_LINKED_DOCUMENTS = 3;

export interface LinkedDocumentCitation {
  kind: "document";
  linkedDocumentId: number;
  title: string;
  spaceId: null;
  updatedAt: Date;
}

const UNTITLED = "Company document";

@Injectable()
export class KbLinkedDocumentAskSource {
  constructor(
    private readonly flags: KbHrLinkFlagsService,
    private readonly access: AccessService,
    private readonly query: KbLinkedDocumentQueryService,
    private readonly audit: AuditService,
  ) {}

  async retrieve(user: CurrentUserContext, question: string): Promise<LinkedDocumentItem[]> {
    if (!(await this.flags.getEffective(user.orgId)).ai) return [];
    return this.query.searchForCaller(await this.caller(user), question, KB_ASK_MAX_LINKED_DOCUMENTS);
  }

  async stillCitable(user: CurrentUserContext, linkedDocumentIds: readonly number[]): Promise<Set<number>> {
    if (linkedDocumentIds.length === 0) return new Set();
    if (!(await this.flags.getEffective(user.orgId)).ai) return new Set();
    const citable = await this.query.visibleIds(await this.caller(user), linkedDocumentIds);
    if (citable.size > 0) await this.auditCitation(user, [...citable]);
    return citable;
  }

  private async auditCitation(user: CurrentUserContext, linkedDocumentIds: readonly number[]): Promise<void> {
    await this.audit.logCriticalOutsideTransaction({
      action: "kb.ai.answer_cited",
      userId: user.userId,
      orgId: user.orgId,
      targetId: linkedDocumentIds.map(String).join(","),
      targetType: "kb_linked_document",
      metadata: { linkedDocumentIds: [...linkedDocumentIds], count: linkedDocumentIds.length },
    });
  }

  citationOf(document: LinkedDocumentItem): LinkedDocumentCitation {
    return { kind: "document", linkedDocumentId: document.id, title: document.name ?? UNTITLED, spaceId: null, updatedAt: document.publishedAt };
  }

  passageOf(document: LinkedDocumentItem): KbContextPassage {
    const facts = [
      "This is a company document shared from HR. Only its details are available here, not the contents of the file.",
      document.category ? `Category: ${document.category}` : null,
      document.effectiveDate ? `Effective from: ${document.effectiveDate}` : null,
      document.version === null ? null : `Version: ${document.version}`,
      document.description ? `Description: ${document.description}` : null,
    ];
    return {
      documentKey: `document:${document.id}`,
      documentTitle: document.name ?? UNTITLED,
      passageIndex: null,
      position: "company document, details only",
      text: facts.filter((fact) => fact !== null).join("\n"),
    };
  }

  private async caller(user: CurrentUserContext): Promise<LinkedDocumentCaller> {
    return { orgId: user.orgId, userId: user.userId, canPublish: await this.access.holds(user, "hr:documents:publish") };
  }
}
