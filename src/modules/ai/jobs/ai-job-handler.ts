import { Injectable } from "@nestjs/common";

export const AI_JOB_HANDLERS = "AI_JOB_HANDLERS";

export interface AiJobContext {
  id: number;
  orgId: string;
  userId: string | null;
  payload: Record<string, unknown>;
}

export interface AiJobHandler {
  readonly type: string;
  handle(job: AiJobContext): Promise<Record<string, unknown>>;
}

@Injectable()
export class AiJobHandlerRegistry {
  private readonly map = new Map<string, AiJobHandler>();

  register(handler: AiJobHandler): void {
    this.map.set(handler.type, handler);
  }

  resolve(type: string): AiJobHandler | undefined {
    return this.map.get(type);
  }
}
