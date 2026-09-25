import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import type { KbContextPassage } from "../retrieval/kb-ask-context";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";
import type { LinkedDocumentItem } from "./dto/kb-linked-documents-response.schemas";

/** The most company documents one answer may draw on; the page and source retrieval have their own, larger, budgets. */
export const KB_ASK_MAX_LINKED_DOCUMENTS = 3;

export interface LinkedDocumentCitation {
  kind: "document";
  linkedDocumentId: number;
  title: string;
  spaceId: null;
  updatedAt: Date;
}

const UNTITLED = "Company document";

/**
 * HR documents as a source for the knowledge-base assistant, opt-in per tenant (`hrms.kb.ai`). Everything
 * the assistant is shown here is something the asker could open from the Company documents list at this moment:
 * the query service applies the live guard and the asker's audience in SQL, so a document that is withdrawn,
 * personal, or meant for someone else is never retrieved, never put in the prompt and never cited. With the
 * switch off this returns nothing and asks the database nothing more. Only the document's own metadata is
 * used; the text of no HR file is read, extracted or sent to a model.
 */
@Injectable()
export class KbLinkedDocumentAskSource {
  constructor(
    private readonly flags: KbHrLinkFlagsService,
    private readonly access: AccessService,
    private readonly query: KbLinkedDocumentQueryService,
  ) {}

  async retrieve(user: CurrentUserContext, question: string): Promise<LinkedDocumentItem[]> {
    if (!(await this.flags.getEffective(user.orgId)).ai) return [];
    return this.query.searchForCaller(await this.caller(user), question, KB_ASK_MAX_LINKED_DOCUMENTS);
  }

  /** Citations that are still valid now: entries withdrawn, or switched off, since retrieval are dropped. */
  async stillCitable(user: CurrentUserContext, linkedDocumentIds: readonly number[]): Promise<Set<number>> {
    if (linkedDocumentIds.length === 0) return new Set();
    if (!(await this.flags.getEffective(user.orgId)).ai) return new Set();
    return this.query.visibleIds(await this.caller(user), linkedDocumentIds);
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
