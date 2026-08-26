import { ConflictException } from "@nestjs/common";
import { duplicateFieldAssignments, type MappedColumn } from "./column-mapping";
import { isFieldOf, type ImportEntity } from "./import-entities";

/**
 * A person's answers to the columns the system would not guess.
 *
 * Applied to the mapping rather than remembered separately, so there is one
 * description of what each column means by the time anything is planned.
 */
export function applyOverrides(
  entity: ImportEntity,
  columns: MappedColumn[],
  overrides: Readonly<Record<string, string>> | undefined,
): MappedColumn[] {
  const answered = !overrides
    ? columns
    : columns.map((column): MappedColumn => {
        const answer = overrides[column.header];
        if (!answer) return column;
        if (answer === "__ignore__")
          return { header: column.header, mapping: { kind: "unmapped" } };

        /**
         * Narrowed against THIS entity's fields, not against every field there
         * is. The DTO validates the union of all four vocabularies, because it
         * cannot know the entity when the enum is built — so "closeDate" on a
         * party import is a legal string that means nothing here, and accepting
         * it would silently drop the column the person was trying to answer for.
         */
        if (!isFieldOf(entity, answer))
          throw new ConflictException(
            `"${answer}" is not a field a ${entity} import can fill.`,
          );

        return {
          header: column.header,
          // A person's answer is certain by definition; that is what asking was for.
          mapping: { kind: "mapped", field: answer, confidence: 1 },
        };
      });

  /**
   * `mapColumns` refuses to map one field twice, but it runs before these
   * answers are applied and an answer names a field outright — so two columns
   * can still end up claiming `name`, and the rightmost would silently win for
   * every row of the file. Asking again is pointless when the answer to the
   * question caused it, so this is a refusal with the way out in it.
   */
  const [collision] = duplicateFieldAssignments(answered);
  if (collision)
    throw new ConflictException(
      `"${collision.headers.join('" and "')}" are both set to ${collision.field}. ` +
        `One field can only be filled from one column — set the others to "__ignore__" or give them a field of their own.`,
    );

  return answered;
}
