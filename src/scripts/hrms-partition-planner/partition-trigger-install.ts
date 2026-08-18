import type postgres from "postgres";
import {
  partitionFamilies,
  type TriggerRecipe,
} from "./partition-config";
import type { PartitionPlanItem } from "./partition-plan";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;

function quotedIdentifier(identifier: string): string {
  if (!identifierPattern.test(identifier))
    throw new Error(`unsafe trigger identifier: ${identifier}`);
  return `"${identifier}"`;
}

function triggerSql(recipe: TriggerRecipe, child: string): string {
  const trigger = quotedIdentifier(recipe.name);
  const relation = `public.${quotedIdentifier(child)}`;
  const triggerFunction = `${quotedIdentifier(recipe.functionSchema)}.${quotedIdentifier(
    recipe.functionName,
  )}()`;
  if (recipe.kind === "mutation")
    return `CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}`;
  if (recipe.kind === "truncate")
    return `CREATE TRIGGER ${trigger} BEFORE TRUNCATE ON ${relation} FOR EACH STATEMENT EXECUTE FUNCTION ${triggerFunction}`;
  return `CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON ${relation} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}`;
}

export async function installLeafTriggers(
  tx: postgres.TransactionSql,
  item: PartitionPlanItem,
): Promise<void> {
  const family = partitionFamilies[item.parent];
  const rows = await tx<Array<{ trigger_name: string }>>`
    SELECT catalog_trigger.tgname AS trigger_name
    FROM pg_trigger catalog_trigger
    JOIN pg_class child ON child.oid = catalog_trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
    WHERE namespace.nspname = 'public'
      AND child.relname = ${item.child}
      AND NOT catalog_trigger.tgisinternal
  `;
  const existing = new Set(rows.map((row) => row.trigger_name));
  for (const recipe of family.leafTriggers) {
    if (existing.has(recipe.name)) continue;
    await tx.unsafe(triggerSql(recipe, item.child));
  }
}
