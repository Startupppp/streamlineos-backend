/**
 * KB's view of document text extraction. The implementation moved to
 * `common/documents` when recruitment resume intake became a second caller;
 * these names are kept so KB's call sites read in KB's vocabulary.
 */
export {
  extractDocumentText as extractAttachmentText,
  isExtractableMime,
} from "../../../common/documents/extract-document-text.util";
