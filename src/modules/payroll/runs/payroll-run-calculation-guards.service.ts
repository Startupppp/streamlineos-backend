import { Injectable } from "@nestjs/common";
import type { SensitiveEmploymentFacts } from "../../directory/employment-facts.types";

export interface StatutoryIdFlags {
  missingPfUan: boolean;
  missingEsiIp: boolean;
}

@Injectable()
export class PayrollRunCalculationGuardsService {
  findDuplicateBankAccounts(
    userIds: string[],
    sensitiveFacts: Map<string, SensitiveEmploymentFacts>,
  ): string[] {
    if (userIds.length < 2) return [];
    const keyToUserIds = new Map<string, string[]>();
    for (const userId of userIds) {
      const facts = sensitiveFacts.get(userId);
      const account = facts?.bankDetails?.accountNumber?.trim().toLowerCase();
      if (!account) continue;
      const key = `${account}|${(facts?.bankDetails?.ifsc ?? "").trim().toLowerCase()}`;
      const list = keyToUserIds.get(key) ?? [];
      list.push(userId);
      keyToUserIds.set(key, list);
    }
    const duplicates = new Set<string>();
    for (const list of keyToUserIds.values()) {
      if (list.length > 1) list.forEach((id) => duplicates.add(id));
    }
    return [...duplicates];
  }

  loadStatutoryIdFlags(
    userIds: string[],
    sensitiveFacts: Map<string, SensitiveEmploymentFacts>,
  ): Map<string, StatutoryIdFlags> {
    const flags = new Map<string, StatutoryIdFlags>();
    for (const userId of userIds) {
      const facts = sensitiveFacts.get(userId);
      const uan = facts?.bankDetails?.pfUanNumber?.trim() ?? "";
      const ip = facts?.bankDetails?.esiIpNumber?.trim() ?? "";
      flags.set(userId, {
        missingPfUan: !/^\d{12}$/.test(uan),
        missingEsiIp: ip.length === 0,
      });
    }
    return flags;
  }
}
