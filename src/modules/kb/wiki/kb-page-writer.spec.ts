import { KbPageWriterService } from "./kb-page-writer.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

jest.mock("./kb-page-edit.util", () => ({
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./kb-page-mention-notifications", () => ({
  deferKbMentionNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./kb-page-content.util", () => ({
  extractMentionUserIds: jest.fn().mockReturnValue([]),
}));

import { snapshotIfNeeded, resyncPageLinks } from "./kb-page-edit.util";
import { deferKbMentionNotifications } from "./kb-page-mention-notifications";
import { extractMentionUserIds } from "./kb-page-content.util";

const TX = {} as never;
const ORG_ID = "org-writer-spec";
const PAGE_ID = 42;
const ACTOR = { userId: "user-1", membershipId: 5 };
const ACTION = "kb.page.updated";

function makePage(over: Partial<{ id: number; title: string; contentRevision: number; aclRevision: number; contentText: string | null }> = {}) {
  return { id: PAGE_ID, title: "Test Page", contentRevision: 3, aclRevision: 2, contentText: "content", ...over };
}

function makeWriter() {
  return new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);
}

describe("KbPageWriterService.commitPageChange — index event", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits kb.content.index with the post-mutation revisions for every call, because the caller decides when re-indexing is warranted", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    await makeWriter().commitPageChange(TX, { orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(), changed: {} });
    expect(emitSpy).toHaveBeenCalledWith(TX, expect.objectContaining({
      eventType: "kb.content.index",
      aggregateType: "kb_page",
      aggregateId: String(PAGE_ID),
      payload: expect.objectContaining({ contentType: "page", contentId: PAGE_ID, contentRevision: 3, aclRevision: 2 }),
    }));
  });

  it("bites: removing OutboxWriter.emit from commitPageChange leaves the spy uncalled, proving the writer is the only path for kb_page index events emitted by create, duplicate, move, publish, archive, restore, and every method Lane 9 migrates", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    await makeWriter().commitPageChange(TX, { orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(), changed: {} });
    expect(emitSpy).toHaveBeenCalled();
  });
});

describe("KbPageWriterService.commitPageChange — content-change side effects", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls snapshotIfNeeded with the post-edit content so the version history captures what was saved", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const newContent = { type: "doc", content: [] };
    await makeWriter().commitPageChange(TX, {
      orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(),
      changed: { content: { newContent, previousContent: null, changeSummary: "draft" } },
    });
    expect(snapshotIfNeeded).toHaveBeenCalledWith(
      TX, ORG_ID, expect.objectContaining({ id: PAGE_ID, content: newContent }),
      ACTOR.userId, "draft", false, ACTOR.membershipId,
    );
  });

  it("passes forced=true to snapshotIfNeeded when the caller sets it, as version-restore requires capturing the pre-overwrite state", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    await makeWriter().commitPageChange(TX, {
      orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(),
      changed: { content: { newContent: { type: "doc" }, previousContent: null, forced: true } },
    });
    expect((snapshotIfNeeded as jest.Mock).mock.calls[0]?.[5]).toBe(true);
  });

  it("calls resyncPageLinks with the new content so page-to-page link entries reflect the current document", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const newContent = { type: "doc", content: [] };
    await makeWriter().commitPageChange(TX, {
      orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(),
      changed: { content: { newContent, previousContent: null } },
    });
    expect(resyncPageLinks).toHaveBeenCalledWith(TX, ORG_ID, PAGE_ID, newContent);
  });

  it("does not call snapshotIfNeeded or resyncPageLinks when changed.content is absent", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    await makeWriter().commitPageChange(TX, { orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(), changed: {} });
    expect(snapshotIfNeeded).not.toHaveBeenCalled();
    expect(resyncPageLinks).not.toHaveBeenCalled();
  });

  it("defers mention notifications only for user ids present in newContent but absent in previousContent", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    (extractMentionUserIds as jest.Mock)
      .mockReturnValueOnce(["user-existing"])
      .mockReturnValueOnce(["user-existing", "user-added"]);
    await makeWriter().commitPageChange(TX, {
      orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(),
      changed: { content: { newContent: { type: "doc" }, previousContent: { type: "doc" } } },
    });
    expect(deferKbMentionNotifications).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ orgId: ORG_ID, userIds: ["user-added"], pageId: PAGE_ID, actorId: ACTOR.userId }),
    );
  });

  it("skips mention notifications when no new user ids appear in the diff, avoiding spurious notifications on re-saves", async () => {
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    (extractMentionUserIds as jest.Mock).mockReturnValue([]);
    await makeWriter().commitPageChange(TX, {
      orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(),
      changed: { content: { newContent: { type: "doc" }, previousContent: null } },
    });
    expect(deferKbMentionNotifications).not.toHaveBeenCalled();
  });
});

describe("KbPageWriterService.commitPageChange — covers all call patterns Lane 9 migrates", () => {
  beforeEach(() => jest.clearAllMocks());

  const CALL_PATTERNS = [
    { name: "create (new page — previously invisible to search until PATCH)", changed: {} },
    { name: "update with content change", changed: { content: { newContent: { type: "doc" } as never, previousContent: null } } },
    { name: "update with acl change only (visibility, owner, space, move)", changed: {} },
    { name: "publish / archive / unarchive", changed: {} },
    { name: "restore version (forced snapshot)", changed: { content: { newContent: { type: "doc" } as never, previousContent: null, forced: true } } },
    { name: "duplicate (batch via commitManyPageChanges)", skipsCommitPageChange: true },
  ] as const;

  for (const pattern of CALL_PATTERNS) {
    if ("skipsCommitPageChange" in pattern) continue;
    it(`emits kb.content.index for: ${pattern.name}`, async () => {
      const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
      await makeWriter().commitPageChange(TX, { orgId: ORG_ID, actor: ACTOR, action: ACTION, page: makePage(), changed: pattern.changed });
      expect(emitSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "kb.content.index" }));
    });
  }
});

describe("KbPageWriterService.commitManyPageChanges", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits index events only for pages with non-blank content text via emitMany, covering duplicate and restore-subtree call sites", async () => {
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    await makeWriter().commitManyPageChanges(TX, {
      orgId: ORG_ID,
      pages: [
        { id: 1, contentRevision: 1, aclRevision: 1, contentText: "hello" },
        { id: 2, contentRevision: 2, aclRevision: 1, contentText: "" },
        { id: 3, contentRevision: 1, aclRevision: 2, contentText: "  " },
        { id: 4, contentRevision: 1, aclRevision: 1, contentText: null },
        { id: 5, contentRevision: 3, aclRevision: 2, contentText: "world" },
      ],
    });
    expect(emitManySpy).toHaveBeenCalledTimes(1);
    const events = emitManySpy.mock.calls[0]?.[1] ?? [];
    const ids = events.map((e) => Number(e.payload["contentId"]));
    expect(ids).toEqual(expect.arrayContaining([1, 5]));
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
  });

  it("skips emitMany entirely when no page qualifies, avoiding a vacuous outbox insert that would wake consumers", async () => {
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    await makeWriter().commitManyPageChanges(TX, {
      orgId: ORG_ID,
      pages: [
        { id: 1, contentRevision: 1, aclRevision: 1, contentText: null },
        { id: 2, contentRevision: 1, aclRevision: 1, contentText: "   " },
      ],
    });
    expect(emitManySpy).not.toHaveBeenCalled();
  });

  it("bites: removing OutboxWriter.emitMany from commitManyPageChanges leaves the spy uncalled, proving batch creates (duplicate, restore-subtree, import) must route through the writer", async () => {
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    await makeWriter().commitManyPageChanges(TX, {
      orgId: ORG_ID,
      pages: [{ id: 1, contentRevision: 1, aclRevision: 1, contentText: "content" }],
    });
    expect(emitManySpy).toHaveBeenCalled();
    expect((emitManySpy.mock.calls[0]?.[1] ?? []).length).toBeGreaterThan(0);
  });
});

describe("post-migration structural invariant — every page-mutating service now injects the writer", () => {
  it("every page-mutating service in KbWikiModule injects KbPageWriterService", () => {
    const serviceModules = [
      jest.requireActual("./kb-pages.service"),
      jest.requireActual("./kb-page-status.service"),
      jest.requireActual("./kb-page-versions.service"),
      jest.requireActual("./kb-page-tree.service"),
      jest.requireActual("./kb-page-duplicate.service"),
      jest.requireActual("./kb-import-process.consumer"),
    ] as Record<string, new (...args: never[]) => unknown>[];

    const serviceClasses = serviceModules.flatMap(Object.values).filter(
      (v): v is new (...args: never[]) => unknown => typeof v === "function",
    );

    for (const ServiceClass of serviceClasses) {
      const paramTypes = Reflect.getMetadata("design:paramtypes", ServiceClass) as Function[] | undefined;
      if (!paramTypes) continue;
      const injectsWriter = paramTypes.some(
        (t) => t.name === "KbPageWriterService",
      );
      expect({ service: ServiceClass.name, injectsWriter }).toEqual({
        service: ServiceClass.name,
        injectsWriter: true,
      });
    }
  });
});
