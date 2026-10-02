import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

/**
 * `listChannelFiles` must project exactly the columns `chatChannelFilesContract` reads.
 *
 * Twice now the projection and the contract have disagreed and the shared-files panel
 * rendered an error overlay over attachments that had uploaded fine. First the
 * projection was missing columns the contract required; then `fileUrl` was added to
 * satisfy a contract that should never have required it — the column is written empty
 * on every insert (`chat-messages.service.ts`) and a chat attachment is read through
 * `GET /chat/channels/:id/attachments/:attachmentId/url`, so no client renders it.
 * `fileUrl` is now off both sides (CHAT-001).
 *
 * This test captures the projection object passed to `db.select()` and compares its
 * keys BEFORE any DB row arrives, so the assertion binds to the query, not to test
 * data. It fails in both directions: a dropped column the panel needs, and a column
 * put back on the wire that the contract does not declare.
 */

const ORG = "org-1";
const CHANNEL = 5;

const CONTRACT_FILE_COLUMNS = [
  "createdAt",
  "fileKey",
  "fileName",
  "fileSize",
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
  it("projects every column the chatChannelFilesContract requires, and nothing more", async () => {
    const captured = { keys: [] as string[] };
    const db = makeDb(captured);
    const service = new ChatChannelMembersImplementation(db, makeEntities());

    await service.listChannelFiles(CHANNEL, actor());

    expect(captured.keys).toEqual(CONTRACT_FILE_COLUMNS);
  });

  it("does not project fileUrl, which is always empty and which no client reads", async () => {
    const captured = { keys: [] as string[] };
    const db = makeDb(captured);
    const service = new ChatChannelMembersImplementation(db, makeEntities());

    await service.listChannelFiles(CHANNEL, actor());

    expect(captured.keys).not.toContain("fileUrl");
  });
});
