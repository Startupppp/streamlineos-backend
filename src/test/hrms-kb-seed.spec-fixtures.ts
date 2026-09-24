import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Client = ReturnType<typeof postgres>;

export interface SeededMember {
  id: string;
  membershipId: number;
}

export interface SeededOrg {
  orgId: string;
  members: Record<string, SeededMember>;
}

/**
 * A throwaway organisation with named members, for the HRMS-KB real-database specs.
 *
 * `organizations.owner_membership_id` and `organization_members.org_id` reference each other; the FK is
 * DEFERRABLE INITIALLY DEFERRED, so one transaction that reserves the membership ids first and then writes
 * both satisfies it at commit. The first name is the owner. Every id is random, so two specs (or a leftover
 * from a crashed one) never collide, and `dispose` removes what the seed created (audit rows it caused are detached, as the real organisation purge does, and stay behind as platform events).
 */
export class HrmsKbSeed {
  private readonly orgIds: string[] = [];
  private readonly userIds: string[] = [];

  constructor(private readonly sql: Client) {}

  async org(label: string, names: readonly string[]): Promise<SeededOrg> {
    const orgId = `qa-hrmskb-${label}-${randomUUID()}`;
    this.orgIds.push(orgId);
    const members: Record<string, SeededMember> = {};
    await this.sql.begin(async (tx) => {
      const people = names.map((name) => ({ name, id: `qa-${name}-${randomUUID()}` }));
      const membershipIds: number[] = [];
      for (const { name, id } of people) {
        this.userIds.push(id);
        await tx`insert into users (id, email, name) values (${id}, ${`${id}@example.com`}, ${name})`;
        const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
        membershipIds.push(Number(row?.id));
      }
      const owner = membershipIds[0];
      if (owner === undefined) throw new Error("an organisation needs at least one member");
      await tx`insert into organizations (id, name, slug, owner_membership_id) values (${orgId}, ${`QA ${label}`}, ${orgId}, ${owner})`;
      for (const [index, { name, id }] of people.entries()) {
        const membershipId = membershipIds[index];
        if (membershipId === undefined) throw new Error("membership id missing");
        await tx`
          insert into organization_members (id, org_id, user_id, role, status, is_owner)
          values (${membershipId}, ${orgId}, ${id}, ${index === 0 ? "ORG_ADMIN" : "MEMBER"}, ${"ACTIVE"}, ${index === 0})
        `;
        members[name] = { id, membershipId };
      }
    });
    return { orgId, members };
  }

  /** Deletes the organisations (cascading their rows) and then the users. Safe to call twice. */
  async dispose(): Promise<void> {
    for (const orgId of this.orgIds.splice(0)) {
      // audit_logs is append-only (no DELETE for anyone) and holds a NO ACTION foreign key to the organisation, so an
      // audited org cannot simply be deleted. The one mutation the trigger allows is the detachment the real org purge
      // uses: an UPDATE under this setting that turns the row into a platform event.
      await this.sql.begin(async (tx) => {
        await tx`select set_config('app.audit_log_detachment', 'true', true)`;
        await tx`update audit_logs set org_id = null, actor_membership_id = null, is_platform_event = true where org_id = ${orgId}`;
        await tx`delete from organizations where id = ${orgId}`;
      });
    }
    for (const id of this.userIds.splice(0)) await this.sql`delete from users where id = ${id}`;
  }
}

export function member(org: SeededOrg, name: string): SeededMember {
  const found = org.members[name];
  if (!found) throw new Error(`no member "${name}" in ${org.orgId}`);
  return found;
}
