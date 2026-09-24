import type { KbLinkedDocumentAskSource } from "../modules/kb/linked-documents/kb-linked-document-ask-source";

/** The assistant's HR-document source for a spec that is not about it: the tenant has not opted in, so nothing is retrieved. */
export const NO_LINKED_DOCUMENTS = {
  retrieve: async () => [],
  stillCitable: async () => new Set<number>(),
  citationOf: () => {
    throw new Error("A spec that retrieves no company documents must not cite one.");
  },
  passageOf: () => {
    throw new Error("A spec that retrieves no company documents must not build a passage for one.");
  },
} as unknown as KbLinkedDocumentAskSource;
