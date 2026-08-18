import type postgres from "postgres";
import type { TriggerRecipe } from "./partition-config";

type TriggerRow = {
  name: string;
  enabled: string;
  trigger_type: number;
  function_schema: string;
  function_name: string;
  is_constraint: boolean;
  deferrable: boolean;
  initially_deferred: boolean;
  trigger_columns: string;
  argument_count: number;
  has_condition: boolean;
};

function sameRecipe(row: TriggerRow, recipe: TriggerRecipe): boolean {
  return (
    row.name === recipe.name &&
    row.enabled === "O" &&
    row.trigger_type === recipe.triggerType &&
    row.function_schema === recipe.functionSchema &&
    row.function_name === recipe.functionName &&
    row.is_constraint === recipe.constraint &&
    row.deferrable === recipe.deferrable &&
    row.initially_deferred === recipe.initiallyDeferred &&
    row.trigger_columns === "" &&
    row.argument_count === 0 &&
    !row.has_condition
  );
}

export async function assertExactTriggerRecipes(
  tx: postgres.TransactionSql,
  relation: string,
  recipes: TriggerRecipe[],
): Promise<void> {
  const rows = await tx<TriggerRow[]>`
    SELECT
      catalog_trigger.tgname AS name,
      catalog_trigger.tgenabled AS enabled,
      catalog_trigger.tgtype::integer AS trigger_type,
      function_namespace.nspname AS function_schema,
      routine.proname AS function_name,
      catalog_trigger.tgconstraint <> 0 AS is_constraint,
      catalog_trigger.tgdeferrable AS deferrable,
      catalog_trigger.tginitdeferred AS initially_deferred,
      catalog_trigger.tgattr::text AS trigger_columns,
      catalog_trigger.tgnargs::integer AS argument_count,
      catalog_trigger.tgqual IS NOT NULL AS has_condition
    FROM pg_trigger catalog_trigger
    JOIN pg_class relation ON relation.oid = catalog_trigger.tgrelid
    JOIN pg_namespace relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_proc routine ON routine.oid = catalog_trigger.tgfoid
    JOIN pg_namespace function_namespace
      ON function_namespace.oid = routine.pronamespace
    WHERE relation_namespace.nspname = 'public'
      AND relation.relname = ${relation}
      AND NOT catalog_trigger.tgisinternal
    ORDER BY catalog_trigger.tgname
  `;
  const expected = [...recipes].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (
    rows.length !== expected.length ||
    rows.some((row, index) => {
      const recipe = expected[index];
      return recipe === undefined || !sameRecipe(row, recipe);
    })
  )
    throw new Error(`${relation} does not match its exact trigger recipe`);
}
