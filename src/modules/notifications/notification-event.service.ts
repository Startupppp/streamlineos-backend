import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Subject, Observable, interval, merge } from "rxjs";
import { filter, map, takeUntil } from "rxjs/operators";

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

const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_TOKEN_TTL_MS = 120_000;

@Injectable()
export class NotificationEventService implements OnModuleDestroy {
  private readonly events$ = new Subject<NotifEvent>();
  private readonly streamTokens = new Map<string, StreamToken>();
  private readonly closeSignals = new Map<string, Subject<void>>();

  emit(event: NotifEvent): void {
    this.events$.next(event);
  }

  stream(userId: string, orgId: string): Observable<MessageEvent> {
    const key = `${orgId}:${userId}`;
    let close$ = this.closeSignals.get(key);
    if (!close$) {
      close$ = new Subject<void>();
      this.closeSignals.set(key, close$);
    }
    const signal = close$;

    const events$ = this.events$.pipe(
      filter((e) => e.userId === userId && e.orgId === orgId),
      map((e): MessageEvent => ({
        data: JSON.stringify({ type: e.type, notification: e.notification }),
        type: e.type,
      })),
    );

    const heartbeat$ = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map((): MessageEvent => ({ data: "", type: "heartbeat" })),
    );

    return merge(events$, heartbeat$).pipe(takeUntil(signal));
  }

  closeStream(userId: string, orgId: string): void {
    const key = `${orgId}:${userId}`;
    const signal = this.closeSignals.get(key);
    if (signal) {
      signal.next();
      signal.complete();
      this.closeSignals.delete(key);
    }
  }

  generateToken(userId: string, orgId: string): string {
    const token = crypto.randomUUID();
    this.streamTokens.set(token, { userId, orgId, expiresAt: Date.now() + STREAM_TOKEN_TTL_MS });
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

  onModuleDestroy(): void {
    this.events$.complete();
    for (const signal of this.closeSignals.values())
      signal.complete();
    this.closeSignals.clear();
  }
}
