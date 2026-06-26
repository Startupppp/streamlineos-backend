import type { GitProvider, ParsedRef, ParsedTicketRef } from "./git.types";

const KEYED_REF_PATTERN = /\b([A-Z][A-Z0-9]+-\d{1,3})-(\d+)\b/g;
const BARE_REF_PATTERN = /(?<![A-Za-z0-9])#(\d+)\b/g;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseGithubPush(body: Record<string, unknown>): ParsedRef[] {
  const commits = Array.isArray(body.commits) ? body.commits : [];
  const refs: ParsedRef[] = [];
  for (const raw of commits) {
    const commit = asRecord(raw);
    if (!commit) continue;
    const id = asString(commit.id);
    if (!id) continue;
    const message = asString(commit.message) ?? "";
    const author = asRecord(commit.author);
    refs.push({
      refType: "commit",
      externalId: id,
      title: message.split("\n")[0]?.slice(0, 300) || id.slice(0, 12),
      url: asString(commit.url),
      author: author ? asString(author.name) : null,
      status: null,
      text: message,
    });
  }
  return refs;
}

function parseGithubPullRequest(body: Record<string, unknown>): ParsedRef[] {
  const pr = asRecord(body.pull_request);
  if (!pr) return [];
  const number = typeof pr.number === "number" ? pr.number : null;
  if (number === null) return [];
  const title = asString(pr.title) ?? `PR #${number}`;
  const prBody = asString(pr.body) ?? "";
  const user = asRecord(pr.user);
  const action = asString(body.action);
  const merged = pr.merged === true;
  const status = merged ? "merged" : asString(pr.state) ?? action;
  return [{
    refType: "pull_request",
    externalId: String(number),
    title: title.slice(0, 300),
    url: asString(pr.html_url),
    author: user ? asString(user.login) : null,
    status,
    text: `${title}\n${prBody}`,
  }];
}

function parseGitlabPush(body: Record<string, unknown>): ParsedRef[] {
  const commits = Array.isArray(body.commits) ? body.commits : [];
  const refs: ParsedRef[] = [];
  for (const raw of commits) {
    const commit = asRecord(raw);
    if (!commit) continue;
    const id = asString(commit.id);
    if (!id) continue;
    const message = asString(commit.message) ?? "";
    const author = asRecord(commit.author);
    refs.push({
      refType: "commit",
      externalId: id,
      title: message.split("\n")[0]?.slice(0, 300) || id.slice(0, 12),
      url: asString(commit.url),
      author: author ? asString(author.name) : null,
      status: null,
      text: message,
    });
  }
  return refs;
}

function parseGitlabMergeRequest(body: Record<string, unknown>): ParsedRef[] {
  const attrs = asRecord(body.object_attributes);
  if (!attrs) return [];
  const iid = typeof attrs.iid === "number" ? attrs.iid : null;
  if (iid === null) return [];
  const title = asString(attrs.title) ?? `MR !${iid}`;
  const description = asString(attrs.description) ?? "";
  const user = asRecord(body.user);
  return [{
    refType: "pull_request",
    externalId: String(iid),
    title: title.slice(0, 300),
    url: asString(attrs.url),
    author: user ? asString(user.username) : null,
    status: asString(attrs.state),
    text: `${title}\n${description}`,
  }];
}

export function parseEvent(
  provider: GitProvider,
  eventType: string | null,
  body: Record<string, unknown>,
): ParsedRef[] {
  if (provider === "github") {
    if (eventType === "push") return parseGithubPush(body);
    if (eventType === "pull_request") return parseGithubPullRequest(body);
    return [];
  }
  if (provider === "gitlab") {
    if (eventType === "Push Hook" || eventType === "Tag Push Hook") return parseGitlabPush(body);
    if (eventType === "Merge Request Hook") return parseGitlabMergeRequest(body);
    return [];
  }
  return [];
}

export function extractTicketRefs(text: string | null | undefined): ParsedTicketRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: ParsedTicketRef[] = [];

  for (const match of text.matchAll(KEYED_REF_PATTERN)) {
    const projectKey = match[1];
    const ticketNumber = Number(match[2]);
    if (!Number.isFinite(ticketNumber)) continue;
    const dedupeKey = `${projectKey}#${ticketNumber}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({ projectKey, ticketNumber });
  }

  for (const match of text.matchAll(BARE_REF_PATTERN)) {
    const ticketNumber = Number(match[1]);
    if (!Number.isFinite(ticketNumber)) continue;
    const dedupeKey = `*#${ticketNumber}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({ projectKey: null, ticketNumber });
  }

  return refs;
}
