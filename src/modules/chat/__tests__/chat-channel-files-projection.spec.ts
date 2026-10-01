import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

/**
 * `listChannelFiles` must project `fileUrl` from `chat_attachments`.
 *
 * `chatChannelFilesContract` on the frontend requires `fileUrl: z.string()`.
 * The backend projection selected only id/messageId/fileName/fileKey/fileSize/
 * mimeType/createdAt — `fileUrl` was missing. Every call to the shared-files panel
 * returned a Zod parse failure, which rendered as a "server error" overlay.
 *
 * The fix is one added field in the `.select({})` call. This test captures the
 * projection object passed to `db.select()` and verifies the key is present BEFORE
 * any DB row arrives, so the assertion binds to the query, not to test data.
 */

const ORG = "org-1";
const CHANNEL = 5;

const REQUIRED_FILE_COLUMNS = [
  "createdAt",
  "fileKey",
  "fileName",
  "fileSize",
  "fileUrl",
  "id",
  "messageId",
  "mimeType",
];

function actor(): EntityActor {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: 10,
    isOrgOwner: false,
    permissions: [],
  } as unknown as EntityActor;
}

function makeDb(capturedProjection: { keys: string[] }) {
  const orderBy = jest.fn().mockReturnValue({
    limit: jest.fn().mockResolvedValue([]),
  });
  const where = jest.fn().mockReturnValue({ orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const select = jest.fn((projection: Record<string, unknown>) => {
    capturedProjection.keys = Object.keys(projection).sort();
    return { from };
  });

  return {
    query: {
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue({ id: CHANNEL, type: "PUBLIC", isPrivate: false, entityType: null, entityId: null }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 10, isOwner: false }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
    },
    select,
  } as unknown as Db;
}

function makeEntities(): EntityReferenceService {
  return {
    resolve: jest.fn().mockResolvedValue([{ status: "resolved" }]),
    actionsFor: jest.fn().mockResolvedValue([[]]),
  } as unknown as EntityReferenceService;
}

describe("listChannelFiles projection", () => {
  it("projects fileUrl so the shared-files panel contract passes", async () => {
    const captured = { keys: [] as string[] };
    const db = makeDb(captured);
    const service = new ChatChannelMembersImplementation(db, makeEntities());

    await service.listChannelFiles(CHANNEL, actor());

    expect(captured.keys).toContain("fileUrl");
  });

  it("projects every column the chatChannelFilesContract requires", async () => {
    const captured = { keys: [] as string[] };
    const db = makeDb(captured);
    const service = new ChatChannelMembersImplementation(db, makeEntities());

    await service.listChannelFiles(CHANNEL, actor());

    expect(captured.keys).toEqual(REQUIRED_FILE_COLUMNS);
  });
});
