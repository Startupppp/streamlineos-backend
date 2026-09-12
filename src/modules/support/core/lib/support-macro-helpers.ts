import { and, eq } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { organizationMembers, supportTickets, users, organizations } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { appUrl } from "../../../email/app-url";

export async function resolveActiveMembershipId(db: Db, orgId: string, userId: string): Promise<number> {
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
  if (!member) throw new NotFoundException("Active organization member not found");
  return member.id;
}

/**
 * Renders {{customer.name}}/{{ticket.id}}/{{agent.name}}/{{company.name}}/
 * {{portal.link}} against the given ticket — no side effects, no usage
 * bump. Used for the compose-time preview before an agent sends a reply.
 */
export async function renderMacroBody(db: Db, orgId: string, userId: string, ticketId: number, body: string): Promise<string> {
  const [ticket, agent, org] = await Promise.all([
    db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true, requesterName: true },
      with: { creatorMembership: { columns: { id: true }, with: { user: { columns: { name: true } } } } },
    }),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } }),
    db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } }),
  ]);
  if (!ticket) throw new NotFoundException("Ticket not found");

  const customerName = ticket.requesterName ?? ticket.creatorMembership?.user?.name ?? "there";
  const variables: Record<string, string> = {
    "customer.name": customerName,
    "ticket.id": String(ticket.id),
    "agent.name": agent?.name ?? "Support",
    "company.name": org?.name ?? "our team",
    "portal.link": `${appUrl()}/support/portal/tickets/${ticket.id}`,
  };

  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
}
