export type GitProvider = "github" | "gitlab" | "bitbucket";
export type GitRefType = "commit" | "pull_request" | "branch";

export interface ParsedRef {
  refType: GitRefType;
  externalId: string;
  title: string | null;
  url: string | null;
  author: string | null;
  status: string | null;
  text: string;
}

export interface ParsedTicketRef {
  projectKey: string | null;
  ticketNumber: number;
}

export interface ResolvedTicket {
  ref: ParsedTicketRef;
  ticketId: number;
}

export interface GitLinkInput {
  orgId: string;
  ticketId: number;
  connectionId: number | null;
  provider: GitProvider;
  refType: GitRefType;
  externalId: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  status?: string | null;
}

export interface WebhookRequest {
  connectionIdRaw: string | undefined;
  rawBody: string;
  signature256: string | undefined;
  gitlabToken: string | undefined;
  githubEvent: string | undefined;
  gitlabEvent: string | undefined;
  deliveryId: string | undefined;
}
