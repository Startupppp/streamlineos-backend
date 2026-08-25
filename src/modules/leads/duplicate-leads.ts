import { and } from "drizzle-orm";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import type { Db } from "../../db/drizzle.module";
import { LEAD_PARTY_COLUMNS, LEAD_PARTY_JOIN, leadPartyScope } from "./lead-party-reader";

function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length <= b.length ? a : b;
  if (longer.length === 0) return 1;
  let matches = 0;
  for (const ch of shorter) {
    if (longer.includes(ch)) matches++;
  }
  return matches / longer.length;
}

export interface DuplicateLeadEntry {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  source: string | null;
  createdAt: Date | null;
}

export interface DuplicateGroup {
  leads: DuplicateLeadEntry[];
  matchReason: string[];
  score: number;
}

export async function findDuplicateLeads(db: Db, orgId: string): Promise<DuplicateGroup[]> {
  const allLeads = await db
    .select({
      id: LEAD_PARTY_COLUMNS.id,
      name: LEAD_PARTY_COLUMNS.name,
      email: LEAD_PARTY_COLUMNS.email,
      phone: LEAD_PARTY_COLUMNS.phone,
      company: LEAD_PARTY_COLUMNS.company,
      status: LEAD_PARTY_COLUMNS.status,
      source: LEAD_PARTY_COLUMNS.source,
      createdAt: LEAD_PARTY_COLUMNS.createdAt,
    })
    .from(leadPartyMap)
    .innerJoin(businessParties, LEAD_PARTY_JOIN)
    .where(and(...leadPartyScope(orgId)));

  const groups: DuplicateGroup[] = [];
  const paired = new Set<string>();

  for (let i = 0; i < allLeads.length; i++) {
    for (let j = i + 1; j < allLeads.length; j++) {
      const a = allLeads[i];
      const b = allLeads[j];
      const pairKey = `${a.id}-${b.id}`;
      if (paired.has(pairKey)) continue;

      const matchReasons: string[] = [];
      let score = 0;

      const emailA = normalize(a.email);
      const emailB = normalize(b.email);
      if (emailA && emailB && emailA === emailB) {
        matchReasons.push("Same email");
        score += 50;
      }

      const phoneA = (a.phone ?? "").replace(/\D/g, "");
      const phoneB = (b.phone ?? "").replace(/\D/g, "");
      if (phoneA.length >= 8 && phoneB.length >= 8 && phoneA === phoneB) {
        matchReasons.push("Same phone");
        score += 40;
      }

      const nameA = normalize(a.name);
      const nameB = normalize(b.name);
      const nameSim = similarity(nameA, nameB);
      if (nameSim > 0.8) {
        matchReasons.push("Similar name");
        score += Math.round(nameSim * 20);
      }

      const compA = normalize(a.company);
      const compB = normalize(b.company);
      if (compA && compB) {
        const compSim = similarity(compA, compB);
        if (compSim > 0.8) {
          matchReasons.push("Similar company");
          score += Math.round(compSim * 10);
        }
      }

      if (score >= 40 && matchReasons.length > 0) {
        paired.add(pairKey);
        groups.push({
          leads: [a, b],
          matchReason: matchReasons,
          score: Math.min(score, 100),
        });
      }
    }
  }

  return groups.sort((x, y) => y.score - x.score);
}
