import { z } from "zod";

const CONFIRM_ACTION_PREFIX = "CONFIRM_ACTION:";
const CONNECT_INTEGRATION_PREFIX = "CONNECT_INTEGRATION:";

export const askOsDirectiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirm-action"),
    proposalId: z.number(),
    token: z.string(),
    action: z.string(),
    summary: z.string(),
    preview: z.record(z.string(), z.unknown()),
    expiresAt: z.string().optional(),
    title: z.string().optional(),
    confirmLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal("connect-integration"),
    toolkit: z.string(),
    reason: z.enum(["no-connection", "needs-reauth"]),
    summary: z.string(),
  }),
]);

export type AskOsDirective = z.infer<typeof askOsDirectiveSchema>;

export function stripDirectives(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith(CONFIRM_ACTION_PREFIX) &&
        !line.startsWith(CONNECT_INTEGRATION_PREFIX),
    )
    .join("\n")
    .trimEnd();
}

export function serializeDirective(directive: AskOsDirective): string {
  switch (directive.kind) {
    case "confirm-action": {
      const { kind: _kind, ...body } = directive;
      return `${CONFIRM_ACTION_PREFIX}${JSON.stringify(body)}`;
    }
    case "connect-integration": {
      const { kind: _kind, ...body } = directive;
      return `${CONNECT_INTEGRATION_PREFIX}${JSON.stringify(body)}`;
    }
  }
}
