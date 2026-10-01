import {
  kbPageSchema,
  kbPageWithAncestorsSchema,
  kbPageTemplateSchema,
  kbPageVersionSchema,
  kbPublicPageSchema,
} from "./kb-wiki-response.schemas";

const KB_PAGE_BASE_FIXTURE = {
  id: 1,
  orgId: "org-1",
  spaceId: null,
  parentPageId: null,
  sortOrder: null,
  projectId: null,
  title: "Architecture Decision Record",
  icon: null,
  coverImage: null,
  status: "published",
  contentType: "rich-text",
  trustState: "verified",
  visibility: "org",
  publicToken: null,
  publicSlug: null,
  content: null,
  contentText: null,
  isLocked: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  deletedAt: null,
  createdByMembershipId: 1,
  lastEditedByMembershipId: 1,
  deletedByMembershipId: null,
  ownerMembershipId: 1,
  verifiedByMembershipId: 1,
  createdById: "user-1",
  lastEditedById: "user-1",
  deletedById: null,
  ownerUserId: "user-1",
  verifiedById: "user-1",
  verifiedUntil: null,
  nextReviewAt: null,
  aclRevision: 3,
  contentRevision: 7,
  legalHold: false,
  legalHoldReason: null,
};

const ARRAY_CONTENT = [{ type: "paragraph", content: [] }, { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hello" }] }];
const RECORD_CONTENT = { type: "doc", content: [{ type: "paragraph" }] };

describe("kbPageSchema — content field accepts the full KbPageContent union so a template with array blocks does not 500 the create endpoint via @ResponseSchema", () => {
  it("accepts null content so an empty page round-trips without error", () => {
    expect(kbPageSchema.safeParse({ ...KB_PAGE_BASE_FIXTURE, content: null }).success).toBe(true);
  });

  it("accepts record-shaped content so Tiptap JSON documents from existing pages continue to parse", () => {
    expect(kbPageSchema.safeParse({ ...KB_PAGE_BASE_FIXTURE, content: RECORD_CONTENT }).success).toBe(true);
  });

  it("accepts array-shaped content so pages created from templates whose content is a block array are returned without @ResponseSchema throwing 500", () => {
    expect(kbPageSchema.safeParse({ ...KB_PAGE_BASE_FIXTURE, content: ARRAY_CONTENT }).success).toBe(true);
  });
});

describe("kbPageWithAncestorsSchema — content field accepts the full KbPageContent union so getById with template content does not 500", () => {
  const withAncestors = { ...KB_PAGE_BASE_FIXTURE, ancestors: [{ id: 9, title: "Handbook" }], isFavorite: false, canEdit: true };

  it("accepts array-shaped content from a template-created page so the wiki page detail does not break on load", () => {
    expect(kbPageWithAncestorsSchema.safeParse({ ...withAncestors, content: ARRAY_CONTENT }).success).toBe(true);
  });
});

describe("kbPageTemplateSchema — content field accepts the full KbPageContent union so templates whose blocks are stored as arrays can be listed", () => {
  const TEMPLATE_FIXTURE = {
    id: 1,
    orgId: "org-1",
    name: "Meeting Notes",
    icon: null,
    description: null,
    content: null,
    createdById: "user-1",
    createdByName: "Ada Lovelace",
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("accepts array-shaped template content so the template listing endpoint does not 500 on org templates with block-array content", () => {
    expect(kbPageTemplateSchema.safeParse({ ...TEMPLATE_FIXTURE, content: ARRAY_CONTENT }).success).toBe(true);
  });

  it("accepts record-shaped template content so existing Tiptap-doc templates continue to parse", () => {
    expect(kbPageTemplateSchema.safeParse({ ...TEMPLATE_FIXTURE, content: RECORD_CONTENT }).success).toBe(true);
  });
});

describe("kbPageVersionSchema — content field accepts the full KbPageContent union so page history can render versions with array content", () => {
  const VERSION_FIXTURE = {
    id: 5,
    orgId: "org-1",
    pageId: 1,
    versionNumber: 3,
    title: "v3",
    content: null,
    contentText: null,
    changeSummary: null,
    authorId: "user-1",
    authorMembershipId: 1,
    authorName: "Ada Lovelace",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("accepts array-shaped content in a version so page history does not 500 when displaying a template-derived revision", () => {
    expect(kbPageVersionSchema.safeParse({ ...VERSION_FIXTURE, content: ARRAY_CONTENT }).success).toBe(true);
  });
});

describe("kbPublicPageSchema — content field accepts the full KbPageContent union so publicly shared pages with array content render", () => {
  const PUBLIC_FIXTURE = {
    title: "Public Policy",
    icon: null,
    coverImage: null,
    content: null,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("accepts array-shaped content on a public page so public-facing wiki pages created from templates do not show errors", () => {
    expect(kbPublicPageSchema.safeParse({ ...PUBLIC_FIXTURE, content: ARRAY_CONTENT }).success).toBe(true);
  });
});
