import type { Aggregate, Schema } from 'mongoose';

/**
 * Data-layer tenant isolation. Applied to every tenant-owned collection: any query, update, delete or aggregate
 * that does not carry an `organizationId` condition THROWS, instead of quietly returning other tenants' rows.
 * That turns "someone forgot the filter" from a data leak into a failing request.
 *
 * Platform code that must span tenants (a super admin overview) opts in explicitly, per query:
 *   Model.find(filter).setOptions({ allowCrossTenant: true })
 *   Model.aggregate(pipeline).option({ allowCrossTenant: true })
 * (Creating a document is covered by the schema: `organizationId` is required.)
 */
export const CROSS_TENANT = { allowCrossTenant: true } as const;

/** True when `organizationId` appears with a real (non-null) value anywhere in the filter, including in $and / $or. */
export function mentionsTenant(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter)) return filter.some(mentionsTenant);
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === 'organizationId') return value !== null && value !== undefined;
    if ((key === '$and' || key === '$or') && mentionsTenant(value)) return true;
  }
  return false;
}

const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
] as const;

export function tenantGuard(schema: Schema, name: string): void {
  for (const op of QUERY_OPS) {
    schema.pre(op, function (this: { getFilter(): unknown; getOptions(): Record<string, unknown> }) {
      if (this.getOptions().allowCrossTenant === true) return;
      if (!mentionsTenant(this.getFilter())) {
        throw new Error(`${name}.${op}() was called without a tenant condition (organizationId)`);
      }
    });
  }
  schema.pre<Aggregate<unknown>>('aggregate', function () {
    if ((this.options as Record<string, unknown>)?.allowCrossTenant === true) return;
    const first = this.pipeline()[0] as Record<string, unknown> | undefined;
    if (!first || !('$match' in first) || !mentionsTenant(first.$match)) {
      throw new Error(`${name}.aggregate() must start with a $match on organizationId`);
    }
  });
}
