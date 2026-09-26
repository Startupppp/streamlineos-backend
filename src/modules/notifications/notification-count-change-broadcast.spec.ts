import type { Db } from "../../db/drizzle.module";
import { NotificationsLifecycleService } from "./notifications-lifecycle.service";

function makeService(): { svc: NotificationsLifecycleService; emitMock: jest.Mock } {
  const returning = jest.fn().mockResolvedValue([{ id: 42 }]);
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: 7 }]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning }),
      }),
    }),
  } as unknown as Db;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
  const emitMock = jest.fn();
  const notifEvents = { emit: emitMock } as never;
  return { svc: new NotificationsLifecycleService(db, cache, notifEvents), emitMock };
}

const countChanged = expect.objectContaining({ type: "count_changed" });

describe("every lifecycle write that moves the server's unread predicate tells the open streams so", () => {
  it("broadcasts after approve, which sets isRead and therefore drops the row out of the badge", async () => {
    const { svc, emitMock } = makeService();
    await svc.approve("org-1", "user-1", 42);
    expect(emitMock).toHaveBeenCalledWith(countChanged);
  });

  it("broadcasts after reject, which sets isRead for the same reason approve does", async () => {
    const { svc, emitMock } = makeService();
    await svc.reject("org-1", "user-1", 42);
    expect(emitMock).toHaveBeenCalledWith(countChanged);
  });

  it("broadcasts after unarchive, where the badge goes UP — archive already broadcasts, so the silence was one-directional", async () => {
    const { svc, emitMock } = makeService();
    await svc.unarchive("org-1", "user-1", 42);
    expect(emitMock).toHaveBeenCalledWith(countChanged);
  });

  it("still broadcasts after archive, the direction that already worked", async () => {
    const { svc, emitMock } = makeService();
    await svc.archive("org-1", "user-1", 42);
    expect(emitMock).toHaveBeenCalledWith(countChanged);
  });

  it("still broadcasts after markRead", async () => {
    const { svc, emitMock } = makeService();
    await svc.markRead("org-1", "user-1", 42);
    expect(emitMock).toHaveBeenCalledWith(countChanged);
  });
});

describe("a write that cannot move the unread predicate stays silent, so the broadcast is not a blanket after-write hook", () => {
  it("does not broadcast after pin, which changes ordering and nothing the count reads", async () => {
    const { svc, emitMock } = makeService();
    await svc.pin("org-1", "user-1", 42);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("does not broadcast after unpin, for the same reason", async () => {
    const { svc, emitMock } = makeService();
    await svc.unpin("org-1", "user-1", 42);
    expect(emitMock).not.toHaveBeenCalled();
  });
});
