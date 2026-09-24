import { firstValueFrom, Subject } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { NotificationEventService } from "./notification-event.service";

describe("notification stream teardown", () => {
  it("forgets a subscriber once its connection ends", () => {
    const service = new NotificationEventService();

    const subscription = service.stream("user-1", "org-1").subscribe();
    expect(service.openStreamCount()).toBe(1);

    subscription.unsubscribe();
    expect(service.openStreamCount()).toBe(0);
  });

  it("keeps the stream open for a second tab when the first one closes", async () => {
    const service = new NotificationEventService();

    const first = service.stream("user-1", "org-1").subscribe();
    const secondEvents = firstValueFrom(
      service.stream("user-1", "org-1").pipe(take(1), toArray()),
    );

    first.unsubscribe();
    expect(service.openStreamCount()).toBe(1);

    service.emit({
      userId: "user-1",
      orgId: "org-1",
      type: "notification",
      notification: {
        id: 1,
        title: "t",
        message: "m",
        priority: "NORMAL",
        category: "GENERAL",
      },
    });

    const received = await secondEvents;
    expect(received).toHaveLength(1);
    expect(service.openStreamCount()).toBe(0);
  });

  it("does not leak an entry per connection for the same user", () => {
    const service = new NotificationEventService();

    const subs = [
      service.stream("user-1", "org-1").subscribe(),
      service.stream("user-1", "org-1").subscribe(),
      service.stream("user-1", "org-1").subscribe(),
    ];
    expect(service.openStreamCount()).toBe(1);

    for (const sub of subs) sub.unsubscribe();
    expect(service.openStreamCount()).toBe(0);
  });

  it("closes every live stream for a user when the server forces a disconnect", () => {
    const service = new NotificationEventService();
    const completed = new Subject<void>();
    let completions = 0;

    service.stream("user-1", "org-1").subscribe({
      complete: () => {
        completions += 1;
        completed.next();
      },
    });
    service.stream("user-1", "org-1").subscribe({ complete: () => (completions += 1) });

    service.closeStream("user-1", "org-1");

    expect(completions).toBe(2);
    expect(service.openStreamCount()).toBe(0);
  });

  it("leaves other users untouched when one user's streams are closed", () => {
    const service = new NotificationEventService();

    service.stream("user-1", "org-1").subscribe();
    const other = service.stream("user-2", "org-1").subscribe();

    service.closeStream("user-1", "org-1");
    expect(service.openStreamCount()).toBe(1);

    other.unsubscribe();
    expect(service.openStreamCount()).toBe(0);
  });
});
