import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import type { Db } from "../../../db/drizzle.module";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";

/**
 * The timeline must project `file_url`, because a live flow reads it.
 *
 * `types/chat.ts` `MessageAttachment` has always declared `fileUrl: string`. The
 * timeline selected five columns — `id`, `fileName`, `fileKey`, `fileSize`,
 * `mimeType` — and not that one, and `apiClient.get<MessagesPage>` is a cast, so
 * both repositories compiled with the declaration and the projection in open
 * disagreement.
 *
 * It was not cosmetic. `forward-message-dialog.tsx:81` re-posts each attachment
 * as `{ fileName, fileUrl, fileKey, fileSize, mimeType }`, and
 * `sendMessageSchema.attachments` requires `fileUrl: z.string()`
 * (`dto/chat.schemas.ts:53`). So forwarding ANY message that carried an
 * attachment posted `fileUrl: undefined` and came back 400 — a hard, visible
 * failure, unlike the seven silent ones, and it survived because nothing
 * compares a projection to a declaration.
 *
 * Asserted on the QUERY, not on a row a double hands back: a projection is
 * decided by the request, so only the request can prove it.
 */

const ORG = "org-1";
const CHANNEL = 42;
const ME = "user-me";

const REQUIRED_ATTACHMENT_COLUMNS = [
  "fileKey",
  "fileName",
  "fileSize",
  "fileUrl",
  "id",
  "mimeType",
];

interface RelationOptions {
  columns?: Record<string, boolean>;
  with?: Record<string, RelationOptions>;
}

function actor(): EntityActor {
  return {
    orgId: ORG,
    userId: ME,
    membershipId: 11,
    isOrgOwner: false,
    permissions: [],
  } as unknown as EntityActor;
}

function makeService(capture: (options: RelationOptions) => void) {
  const messages = {
    findMany: jest.fn((options: RelationOptions) => {
      capture(options);
      return Promise.resolve([]);
    }),
    findFirst: jest.fn((options: RelationOptions) => {
      capture(options);
      return Promise.resolve(undefined);
    }),
  };
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL, type: "PUBLIC" }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      chatMessages: messages,
    },
  } as unknown as Db;
  const entities = {
    withResolvedReferences: jest.fn(async (_a: unknown, rows: unknown) => rows),
  } as unknown as EntityReferenceService;
  return new ChatMessageTimelineService(db, entities);
}

/** Every `attachments` relation reachable from the captured query options. */
function attachmentProjections(options: RelationOptions, found: RelationOptions[] = []) {
  for (const [key, relation] of Object.entries(options.with ?? {})) {
    if (typeof relation !== "object" || relation === null) continue;
    if (key === "attachments") found.push(relation);
    attachmentProjections(relation, found);
  }
  return found;
}

function assertProjects(options: RelationOptions) {
  const projections = attachmentProjections(options);
  expect(projections.length).toBeGreaterThan(0);
  for (const projection of projections) {
    expect(projection.columns).toBeDefined();
    expect(Object.keys(projection.columns ?? {}).sort()).toEqual(REQUIRED_ATTACHMENT_COLUMNS);
  }
}

describe("chat attachments carry every column a consumer reads", () => {
  it("the timeline list projects fileUrl", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService((o) => seen.push(o));

    await service.list(CHANNEL, actor(), undefined, 50);

    expect(seen).toHaveLength(1);
    const options = seen[0];
    expect(options).toBeDefined();
    if (options === undefined) return;
    assertProjects(options);
  });

  it("the poll path projects fileUrl too, so a polled message forwards as well as a listed one", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService((o) => seen.push(o));

    await service.poll(CHANNEL, actor(), undefined, undefined, 50);

    expect(seen).toHaveLength(1);
    const options = seen[0];
    expect(options).toBeDefined();
    if (options === undefined) return;
    assertProjects(options);
  });

  /**
   * The parent lookup throws 404 on the double's `undefined`, which is after the
   * query the assertion is about — the projection is captured either way.
   */
  it("the thread replies project fileUrl", async () => {
    const seen: RelationOptions[] = [];
    const service = makeService((o) => seen.push(o));

    await expect(service.listThreadReplies(900, actor(), undefined, 50)).rejects.toThrow();

    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) assertProjects(options);
  });
});
