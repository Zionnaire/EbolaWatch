import type { Schema } from 'mongoose';

const BLOCKED = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

/** Makes a collection append-only at the model level: any update or delete through Mongoose throws. */
export function enforceAppendOnly(schema: Schema, name: string): void {
  for (const op of BLOCKED) {
    schema.pre(op, () => {
      throw new Error(`${name} is append-only: ${op} is not allowed`);
    });
  }
}
