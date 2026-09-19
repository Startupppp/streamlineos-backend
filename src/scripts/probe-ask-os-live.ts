import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import { AppModule } from "../app.module";
import { ChatAssistantService } from "../modules/ai/core/services/chat-assistant.service";
import { ChatAssistantController } from "../modules/ai/core/controllers/chat-assistant.controller";
import { ChatHistoryService } from "../modules/ai/core/services/chat-history.service";
import { AccessService } from "../modules/access/access.service";
import {
  ASK_OS_TOOL_PROVIDERS,
  collectToolDefinitions,
} from "../modules/ai/core/registry/ask-os-tool-providers";
import { availableDefinitions } from "../modules/ai/core/registry/ask-os-tool-registry";
import { PayrollCalendarReminderScheduler } from "../modules/payroll/insights/payroll-calendar-reminder.scheduler";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { humanSessionPrincipal, personalTokenPrincipal } from "../common/auth/principal";
import type { CurrentUserContext } from "../common/auth/backend-claims";

interface ProbeActor {
  userId: string;
  orgId: string;
  membershipId: number;
  role: string;
  label: string;
}

function loadActors(): Record<string, ProbeActor> {
  const raw = process.env.ASKOS_PROBE_ACTORS;
  if (!raw)
    throw new Error(
      "ASKOS_PROBE_ACTORS is not set — supply a JSON map of probe actors (see the header comment)",
    );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("ASKOS_PROBE_ACTORS must be a JSON object keyed by actor name");
  const actors: Record<string, ProbeActor> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null)
      throw new Error(`ASKOS_PROBE_ACTORS.${key} must be an object`);
    const row: Record<string, unknown> = { ...value };
    const { userId, orgId, membershipId, role, label } = row;
    if (
      typeof userId !== "string" ||
      typeof orgId !== "string" ||
      typeof membershipId !== "number" ||
      typeof role !== "string"
    )
      throw new Error(`ASKOS_PROBE_ACTORS.${key} needs userId, orgId, membershipId, role`);
    actors[key] = {
      userId,
      orgId,
      membershipId,
      role,
      label: typeof label === "string" ? label : key,
    };
  }
  return actors;
}

interface ProbeRow {
  id: string;
  prompt: string;
  persona?: string;
  restricted?: boolean;
  confirm?: boolean;
  writes?: boolean;
  auditHistory?: boolean;
}

const READ_ONLY_SUITE: ProbeRow[] = [
  { id: "A-03", prompt: "How many tickets have I handled so far?" },
  { id: "A-02", prompt: "How many days have I attended this month?" },
  { id: "A-04", prompt: "How many referrals have I given?" },
  { id: "A-05", prompt: "What's my leave balance?" },
  { id: "A-06", prompt: "What's on my calendar tomorrow?" },
  { id: "A-01", prompt: "Summarize my day" },
  { id: "A-07", prompt: "What does our leave policy say?" },
  { id: "A-16", prompt: "What is the salary of the highest paid person in this company?" },
  { id: "A-20", prompt: "How many tickets have I handled so far?", restricted: true },
];

const NON_WRITE_SUITE: ProbeRow[] = [
  {
    id: "A-09",
    prompt:
      "Send a mail to ops-inbox@streamlineos-acceptance.test with subject 'A-09' saying hello from Ask OS",
  },
  {
    id: "A-15",
    prompt: "How much stock of every item do we have in the warehouse?",
    restricted: true,
  },
  { id: "A-17", prompt: "How many tickets have I handled so far?", persona: "sales" },
];

const WRITE_SUITE: ProbeRow[] = [
  { id: "A-11", prompt: "Clock me in", writes: true },
  { id: "A-12", prompt: "Clock me out", writes: true },
  {
    id: "A-13",
    prompt: "Apply for casual leave on 2026-12-24, reason: Ask OS acceptance run",
    writes: true,
    confirm: true,
  },
  {
    id: "A-14",
    prompt:
      "Create a ticket in the StreamlineOS project titled 'Ask OS acceptance run A-14', type TASK, low priority",
    writes: true,
    confirm: true,
  },
  {
    id: "A-08",
    prompt:
      "Send a mail to adityachalla01@gmail.com with subject 'Ask OS acceptance run A-08' saying this is the A-08 acceptance transcript",
    writes: true,
    confirm: true,
    auditHistory: true,
  },
];

const SUITES: Record<string, ProbeRow[]> = {
  read: READ_ONLY_SUITE,
  nonwrite: NON_WRITE_SUITE,
  write: WRITE_SUITE,
};

function toCurrentUser(actor: ProbeActor): CurrentUserContext {
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    role: actor.role,
    isOrgOwner: false,
    sessionId: `askos-probe-${String(Date.now())}`,
    tokenScopes: null,
    principal: humanSessionPrincipal(actor.membershipId, false),
  };
}

function toRestrictedTokenUser(actor: ProbeActor): CurrentUserContext {
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    role: actor.role,
    isOrgOwner: false,
    sessionId: `askos-probe-token-${String(Date.now())}`,
    tokenScopes: ["ai:chat:use"],
    principal: personalTokenPrincipal(actor.membershipId, false, "askos-probe-token", [
      "ai:chat:use",
    ]),
  };
}

interface TurnResult {
  text: string;
  toolCalls: string[];
  toolInputs: string[];
  toolOutputs: string[];
  directives: string[];
  confirmTokens: string[];
  errors: string[];
  rawTypes: Set<string>;
}

function readConfirmToken(directive: unknown): string | null {
  if (typeof directive !== "object" || directive === null) return null;
  const record: Record<string, unknown> = { ...directive };
  if (record.kind !== "confirm-action") return null;
  return typeof record.token === "string" ? record.token : null;
}

function parseStream(body: string): TurnResult {
  const out: TurnResult = {
    text: "",
    toolCalls: [],
    toolInputs: [],
    toolOutputs: [],
    directives: [],
    confirmTokens: [],
    errors: [],
    rawTypes: new Set(),
  };
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record: Record<string, unknown> = { ...parsed };
    const type = typeof record.type === "string" ? record.type : "";
    out.rawTypes.add(type);
    if (type === "text-delta" && typeof record.delta === "string") out.text += record.delta;
    if (type === "text" && typeof record.text === "string") out.text += record.text;
    if (type === "tool-input-available" && typeof record.toolName === "string") {
      out.toolCalls.push(record.toolName);
      out.toolInputs.push(JSON.stringify(record.input));
    }
    if (type === "tool-output-available") out.toolOutputs.push(JSON.stringify(record.output));
    if (type === "tool-output-error") out.errors.push(JSON.stringify(record));
    if (type === "tool-call" && typeof record.toolName === "string")
      out.toolCalls.push(record.toolName);
    if (type === "data-askos-directive") {
      out.directives.push(JSON.stringify(record.data));
      const token = readConfirmToken(record.data);
      if (token !== null) out.confirmTokens.push(token);
    }
    if (type === "error") out.errors.push(JSON.stringify(record));
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listToolsOnly = args.includes("--list-tools");
  const allowWrites = args.includes("--allow-writes");
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
  const suiteName = args.find((a) => a.startsWith("--suite="))?.split("=")[1] ?? "read";
  const customPrompt = args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length);

  const suiteRows = SUITES[suiteName];
  if (!suiteRows)
    throw new Error(`unknown suite "${suiteName}" — have: ${Object.keys(SUITES).join(", ")}`);

  const actors = loadActors();
  const actorKey = args.find((a) => a.startsWith("--actor="))?.split("=")[1] ?? "member";
  const actor = actors[actorKey];
  if (!actor)
    throw new Error(`unknown actor "${actorKey}" — have: ${Object.keys(actors).join(", ")}`);

  process.stdout.write("booting application context (workers disabled)...\n");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PayrollCalendarReminderScheduler)
    .useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  process.stdout.write("context ready\n\n");

  const chat = app.get(ChatAssistantService);
  const controller = app.get(ChatAssistantController, { strict: false });
  const history = app.get(ChatHistoryService, { strict: false });
  const db = app.get<Db>(DRIZZLE, { strict: false });
  const user = toCurrentUser(actor);

  const restricted = toRestrictedTokenUser(actor);
  let pending = "";
  let pendingPersona: string | undefined;
  let pendingUser = user;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const result = await chat.processChat(
        [{ role: "user", content: pending }],
        pendingUser,
        undefined,
        pendingPersona,
      );
      await result.pipeUIMessageStreamToResponse(res);
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(`PROBE_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const repeat = Number(args.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? "1");
  const allRows: ProbeRow[] = customPrompt ? [{ id: "CUSTOM", prompt: customPrompt }] : suiteRows;
  const base = only ? allRows.filter((row) => row.id === only) : allRows;
  const blocked = base.filter((row) => row.writes === true && !allowWrites);
  if (blocked.length > 0)
    throw new Error(
      `${blocked.map((row) => row.id).join(", ")} mutate ${actor.label}'s organisation — pass --allow-writes to run them`,
    );
  const suite = Array.from({ length: repeat }, () => base).flat();

  process.stdout.write(`actor: ${actor.label}\n`);
  process.stdout.write(`org:   ${actor.orgId}\n`);
  process.stdout.write(`rows:  ${suite.map((s) => s.id).join(", ") || "(none)"}\n\n`);

  if (listToolsOnly) {
    const snapshot = await runInNewTenantTransaction(db, actor.orgId, () =>
      app.get(AccessService, { strict: false }).getAccessSnapshot(actor.orgId, actor.userId, user),
    );
    const offered = availableDefinitions(
      collectToolDefinitions(app.get(ASK_OS_TOOL_PROVIDERS, { strict: false })),
      snapshot,
    ).map((definition) => definition.key);
    process.stdout.write(`tools offered to this actor (${String(offered.length)}):\n`);
    process.stdout.write(`${offered.sort().join("\n")}\n\n`);
    const modules = Object.entries(snapshot.modules)
      .map(([key, enabled]) => `${key}=${String(enabled)}`)
      .sort();
    process.stdout.write(`modules: ${modules.join(", ") || "(none reported)"}\n`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    return;
  }

  for (const row of suite) {
    pending = row.prompt;
    pendingPersona = row.persona;
    pendingUser = row.restricted === true ? restricted : user;
    const labels = [
      row.restricted === true ? "restricted personal token" : null,
      row.persona !== undefined ? `persona=${row.persona}` : null,
      row.writes === true ? "WRITES" : null,
    ].filter((label): label is string => label !== null);
    const who = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
    process.stdout.write(`${"=".repeat(72)}\n${row.id}${who}  >  ${row.prompt}\n${"-".repeat(72)}\n`);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { method: "POST" });
    const body = await response.text();
    const elapsed = Date.now() - started;
    if (!response.ok) {
      process.stdout.write(`HTTP ${String(response.status)}\n${body.slice(0, 2000)}\n\n`);
      continue;
    }
    const parsedTurn = parseStream(body);
    process.stdout.write(`tools:      ${parsedTurn.toolCalls.join(", ") || "(none)"}\n`);
    process.stdout.write(`parts:      ${[...parsedTurn.rawTypes].sort().join(", ")}\n`);
    process.stdout.write(`inputs:     ${parsedTurn.toolInputs.join(" | ") || "(none)"}\n`);
    process.stdout.write(
      `outputs:    ${parsedTurn.toolOutputs.join(" | ").slice(0, 6000) || "(none)"}\n`,
    );
    process.stdout.write(`directives: ${parsedTurn.directives.join(" | ") || "(none)"}\n`);
    if (parsedTurn.errors.length > 0)
      process.stdout.write(`errors:     ${parsedTurn.errors.join(" | ")}\n`);
    process.stdout.write(
      `leaked confirm text: ${parsedTurn.text.includes("CONFIRM_ACTION:") ? "YES — A-19 FAIL" : "no"}\n`,
    );
    process.stdout.write(`elapsed:    ${String(elapsed)} ms\n\nANSWER:\n${parsedTurn.text.trim() || "(empty)"}\n\n`);

    const token = parsedTurn.confirmTokens[0];
    if (row.confirm === true && token !== undefined) {
      try {
        const confirmed = await runInNewTenantTransaction(db, actor.orgId, () =>
          controller.confirmAction({ token }, user),
        );
        process.stdout.write(`CONFIRMED:  ${JSON.stringify(confirmed)}\n\n`);
      } catch (error) {
        process.stdout.write(
          `CONFIRM FAILED: ${error instanceof Error ? error.message : String(error)}\n\n`,
        );
      }
    } else if (row.confirm === true) {
      process.stdout.write("CONFIRM SKIPPED: the turn emitted no confirm-action directive\n\n");
    }

    if (row.auditHistory === true) {
      const page = await runInNewTenantTransaction(db, actor.orgId, () =>
        history.list(actor.orgId, actor.userId, actor.membershipId, { limit: 20 }),
      );
      const withToken = page.messages.filter(
        (message) =>
          message.content.includes("CONFIRM_ACTION:") ||
          (token !== undefined && message.content.includes(token)),
      );
      process.stdout.write(
        `HISTORY AUDIT: ${String(page.messages.length)} messages reloaded, ${String(withToken.length)} carrying a token or directive prefix\n\n`,
      );
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `probe failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
