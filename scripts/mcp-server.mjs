/**
 * StreamlineOS MCP Server (stdio)
 * Exposes project/ticket tooling to Cursor and Claude Code via the StreamlineOS Agent API.
 *
 * Required env:
 *   STREAMLINEOS_TOKEN  — agent bearer token (slos_...)
 * Optional env:
 *   STREAMLINEOS_API_URL — defaults to http://localhost:1500
 *
 * Run: node scripts/mcp-server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env.STREAMLINEOS_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    "Error: STREAMLINEOS_TOKEN environment variable is required.\n" +
      "Set it to your StreamlineOS agent token (slos_...).\n"
  );
  process.exit(1);
}

const BASE_URL = (process.env.STREAMLINEOS_API_URL ?? "http://localhost:1500").replace(/\/$/, "");
const TIMEOUT_MS = 30_000;

async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    ...options,
    signal,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text };
  }

  if (!res.ok) {
    const msg = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    const msgStr = Array.isArray(msg) ? msg.join("; ") : String(msg);
    throw Object.assign(new Error(msgStr), { status: res.status, body });
  }

  return body?.data !== undefined ? body.data : body;
}

function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function guessMimeFromUrl(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

async function fetchImageAsBase64(url, fallbackMime) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const headerMime = res.headers.get("content-type");
  const mimeType =
    headerMime && headerMime.startsWith("image/")
      ? headerMime.split(";")[0].trim()
      : fallbackMime && fallbackMime.startsWith("image/")
        ? fallbackMime
        : guessMimeFromUrl(url);
  return { data: Buffer.from(buf).toString("base64"), mimeType };
}

const server = new McpServer(
  { name: "streamlineos", version: "1.0.0" },
  {
    instructions:
      "StreamlineOS agent workflow:\n" +
      "1. Call list_my_tickets (scope='mine') to see your assigned tickets.\n" +
      "2. Call get_ticket to read a ticket's full details, including image attachments — the tool returns inline images so you can see screenshots, mockups, or bug reports visually.\n" +
      "3. Implement the fix or feature in the local repository.\n" +
      "4. Call add_ticket_comment with a summary of what you changed and a link to the PR/commit.\n" +
      "5. Call move_ticket_status with status='IN_REVIEW' to move the ticket to the review queue.\n\n" +
      "Statuses are project-specific. If IN_REVIEW is rejected, call get_ticket to see the current status and infer valid next statuses from context. Common values: TODO, IN_PROGRESS, IN_REVIEW, DONE.",
  }
);

server.registerTool(
  "list_projects",
  {
    description:
      "List StreamlineOS projects you have access to. Returns a text table with id, key, name, and status.",
    inputSchema: {
      search: z.string().optional().describe("Filter by project name"),
      status: z.string().optional().describe("Filter by status, e.g. ACTIVE or ARCHIVED"),
    },
  },
  async ({ search, status }) => {
    try {
      const query = buildQuery({ search, status, limit: 50 });
      const data = await apiFetch(`/agent/v1/projects${query}`);
      const projects = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (projects.length === 0) {
        return { content: [{ type: "text", text: "No projects found." }] };
      }
      const rows = projects.map(
        (p) => `• [${p.key ?? "?"}] ${p.name} — status: ${p.status ?? "unknown"} (id: ${p.id})`
      );
      return {
        content: [
          {
            type: "text",
            text: `Projects (${projects.length}):\n${rows.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(`list_projects failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "list_my_tickets",
  {
    description:
      "List tickets visible to you. By default returns your assigned tickets (scope='mine'). " +
      "Use scope='all' to see all project tickets, 'created' for tickets you created, or 'subscribed' for tickets you follow. " +
      "Optionally filter by projectId, status, or a search string.",
    inputSchema: {
      projectId: z.number().int().positive().optional().describe("Restrict to a specific project id"),
      status: z.string().optional().describe("Filter by ticket status, e.g. IN_PROGRESS"),
      scope: z
        .enum(["mine", "all", "created", "subscribed"])
        .optional()
        .default("mine")
        .describe("Whose tickets to show (default: mine)"),
      search: z.string().optional().describe("Full-text search over ticket titles"),
      limit: z.number().int().min(1).max(100).optional().default(25).describe("Max results (default 25)"),
    },
  },
  async ({ projectId, status, scope, search, limit }) => {
    try {
      const params = {
        scope: scope ?? "mine",
        status,
        search,
        limit: limit ?? 25,
        assigneeId: scope === "mine" || scope === undefined ? "@me" : undefined,
      };
      if (projectId) params.projectIds = String(projectId);
      const query = buildQuery(params);
      const data = await apiFetch(`/agent/v1/work${query}`);
      const tickets = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (tickets.length === 0) {
        return { content: [{ type: "text", text: "No tickets found matching your criteria." }] };
      }
      const rows = tickets.map((t) => {
        const key = t.projectKey && t.ticketNumber ? `${t.projectKey}-${t.ticketNumber}` : String(t.id);
        const due = t.dueDate ? ` | due: ${t.dueDate}` : "";
        return `• ${key} (id:${t.id}) [${t.status ?? "?"}] [${t.priority ?? "?"}] ${t.title}${due}`;
      });
      const total = data?.total ?? tickets.length;
      return {
        content: [
          {
            type: "text",
            text: `Tickets (showing ${tickets.length} of ${total}):\n${rows.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(`list_my_tickets failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_ticket",
  {
    description:
      "Fetch full details of a ticket by id, including description, comments, and attachments. " +
      "Image attachments (screenshots, mockups, bug reports) are returned inline as MCP image content blocks so you can see them directly. " +
      "Up to 4 images are shown; oversized images (>4 MB) are listed as text links instead.",
    inputSchema: {
      ticketId: z.number().int().positive().describe("The numeric ticket id (not the key)"),
      includeImages: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to fetch and embed image attachments inline (default true)"),
    },
  },
  async ({ ticketId, includeImages }) => {
    try {
      const ticket = await apiFetch(`/agent/v1/tickets/${ticketId}`);
      const project = ticket.project ?? {};
      const key =
        project.key && ticket.ticketNumber
          ? `${project.key}-${ticket.ticketNumber}`
          : `Ticket #${ticket.id}`;

      const commentLines =
        Array.isArray(ticket.comments) && ticket.comments.length > 0
          ? ticket.comments
              .slice(-10)
              .map((c) => `  [${c.authorName ?? c.authorId ?? "?"}]: ${c.body}`)
              .join("\n")
          : "  (no comments)";

      const attachments = Array.isArray(ticket.attachments) ? ticket.attachments : [];
      const imageAttachments = attachments.filter(
        (a) => typeof a.mimeType === "string" && a.mimeType.startsWith("image/")
      );
      const nonImageAttachments = attachments.filter(
        (a) => !(typeof a.mimeType === "string" && a.mimeType.startsWith("image/"))
      );

      const attachmentText =
        nonImageAttachments.length > 0
          ? "\nNon-image attachments:\n" +
            nonImageAttachments
              .map((a) => `  • ${a.fileName} (${a.mimeType}) — ${a.fileUrl}`)
              .join("\n")
          : "";

      const inlineImages = Array.isArray(ticket.inlineImages) ? ticket.inlineImages : [];

      const imageSources = [
        ...imageAttachments.map((a) => ({
          url: a.fileUrl,
          label: a.fileName,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
        })),
        ...inlineImages.map((i) => ({
          url: i.url,
          label: `inline image from ${i.source}`,
          mimeType: null,
          fileSize: null,
        })),
      ];

      const summary =
        `${key}\n` +
        `Title:       ${ticket.title ?? ""}\n` +
        `Status:      ${ticket.status ?? ""}\n` +
        `Priority:    ${ticket.priority ?? ""}\n` +
        `Type:        ${ticket.type ?? ""}\n` +
        `Project:     ${project.name ?? ""} (${project.key ?? ""})\n` +
        `Due Date:    ${ticket.dueDate ?? "none"}\n` +
        `\nDescription:\n${ticket.description ?? "(none)"}\n` +
        `\nRecent Comments:\n${commentLines}` +
        (attachments.length > 0
          ? `\n\nAttachments (${attachments.length} total):\n` +
            attachments.map((a) => `  • ${a.fileName} (${a.mimeType})`).join("\n")
          : "") +
        attachmentText +
        (imageSources.length > 0
          ? `\n\nImages (${imageSources.length} total — embedded below where possible):\n` +
            imageSources.map((s) => `  • ${s.label} — ${s.url}`).join("\n")
          : "");

      const contentBlocks = [{ type: "text", text: summary }];

      const shouldEmbedImages = includeImages !== false;
      if (shouldEmbedImages && imageSources.length > 0) {
        const toEmbed = imageSources.slice(0, 4);
        const MAX_BYTES = 4 * 1024 * 1024;

        for (const img of toEmbed) {
          if (typeof img.fileSize === "number" && img.fileSize > MAX_BYTES) {
            contentBlocks.push({
              type: "text",
              text: `[Image too large to embed: ${img.label} (${(img.fileSize / 1024 / 1024).toFixed(1)} MB) — ${img.url}]`,
            });
            continue;
          }
          try {
            const fetched = await fetchImageAsBase64(img.url, img.mimeType);
            if (fetched) {
              contentBlocks.push({ type: "image", data: fetched.data, mimeType: fetched.mimeType });
            } else {
              contentBlocks.push({
                type: "text",
                text: `[Could not fetch image: ${img.label} — ${img.url}]`,
              });
            }
          } catch {
            contentBlocks.push({
              type: "text",
              text: `[Image fetch error: ${img.label} — ${img.url}]`,
            });
          }
        }

        if (imageSources.length > 4) {
          contentBlocks.push({
            type: "text",
            text: `(${imageSources.length - 4} more image(s) not shown — see the image list above for URLs)`,
          });
        }
      }

      return { content: contentBlocks };
    } catch (err) {
      return toolError(`get_ticket failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "move_ticket_status",
  {
    description:
      "Update the status of a ticket. Use status='IN_REVIEW' after completing a fix to signal it is ready for review. " +
      "Statuses are project-specific and workflow rules may restrict transitions. " +
      "If the API returns a 400 error, the workflow does not allow that transition from the current status — the backend message will explain allowed transitions. " +
      "In that case, call get_ticket to see the current status and choose a valid next step.",
    inputSchema: {
      ticketId: z.number().int().positive().describe("The numeric ticket id"),
      status: z
        .string()
        .min(1)
        .describe(
          "The target status string, e.g. IN_REVIEW, IN_PROGRESS, DONE. Must match a valid status in the project's workflow."
        ),
    },
  },
  async ({ ticketId, status }) => {
    try {
      const updated = await apiFetch(`/agent/v1/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      return {
        content: [
          {
            type: "text",
            text: `Ticket #${ticketId} status updated to "${updated.status ?? status}".`,
          },
        ],
      };
    } catch (err) {
      const msg =
        err.status === 400
          ? `Workflow rejected the transition: ${err.message}`
          : `move_ticket_status failed: ${err.message}`;
      return toolError(msg);
    }
  }
);

server.registerTool(
  "add_ticket_comment",
  {
    description:
      "Post a comment on a ticket. Use this to record what you changed, link to a PR/commit, or ask a question. " +
      "Call this before moving the ticket to IN_REVIEW so reviewers have context.",
    inputSchema: {
      ticketId: z.number().int().positive().describe("The numeric ticket id"),
      body: z.string().min(1).describe("The comment body (plain text or markdown)"),
    },
  },
  async ({ ticketId, body }) => {
    try {
      const comment = await apiFetch(`/agent/v1/tickets/${ticketId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return {
        content: [
          {
            type: "text",
            text: `Comment posted on ticket #${ticketId} (comment id: ${comment.id ?? "?"}).`,
          },
        ],
      };
    } catch (err) {
      return toolError(`add_ticket_comment failed: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
