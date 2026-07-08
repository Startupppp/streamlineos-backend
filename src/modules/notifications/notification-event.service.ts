import { Injectable } from "@nestjs/common";
import { Subject, Observable } from "rxjs";
import { filter, map } from "rxjs/operators";

export interface NotifEventPayload {
  id: number;
  title: string;
  message: string;
  priority: string;
  category: string;
  link?: string | null;
  eventKey?: string | null;
}

interface NotifEvent {
  userId: string;
  orgId: string;
  type: string;
  notification?: NotifEventPayload;
}

interface StreamToken {
  userId: string;
  orgId: string;
  expiresAt: number;
}

@Injectable()
export class NotificationEventService {
  private readonly events$ = new Subject<NotifEvent>();
  private readonly streamTokens = new Map<string, StreamToken>();

  emit(event: NotifEvent): void {
    this.events$.next(event);
  }

  stream(userId: string, orgId: string): Observable<MessageEvent> {
    return this.events$.pipe(
      filter((e) => e.userId === userId && e.orgId === orgId),
      map((e) => ({ data: JSON.stringify({ type: e.type, notification: e.notification }) } as MessageEvent)),
    );
  }

  generateToken(userId: string, orgId: string): string {
    const token = crypto.randomUUID();
    this.streamTokens.set(token, { userId, orgId, expiresAt: Date.now() + 120_000 });
    this.pruneTokens();
    return token;
  }

  consumeToken(token: string): { userId: string; orgId: string } | null {
    const entry = this.streamTokens.get(token);
    this.streamTokens.delete(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return { userId: entry.userId, orgId: entry.orgId };
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [key, val] of this.streamTokens) {
      if (val.expiresAt < now) this.streamTokens.delete(key);
    }
  }
}
