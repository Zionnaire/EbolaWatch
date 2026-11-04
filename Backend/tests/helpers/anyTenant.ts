/**
 * The four tenant-owned models, for tests that need to look at the database directly. The real models REFUSE a
 * query without a tenant condition (that is the point of the guard); these wrappers opt in to crossing tenants,
 * for every query and aggregate, so a test can inspect or prepare data without naming an organization.
 * Production code never imports this file.
 */
import { AnalystReviewModel as RealAnalystReviewModel } from '../../src/models/AnalystReview.js';
import { CounterNarrativeModel as RealCounterNarrativeModel } from '../../src/models/CounterNarrative.js';
import { DispatchModel as RealDispatchModel } from '../../src/models/Dispatch.js';
import { InviteModel as RealInviteModel } from '../../src/models/Invite.js';
import { NarrativeReviewModel as RealNarrativeReviewModel } from '../../src/models/NarrativeReview.js';

const QUERY_METHODS = new Set([
  'find',
  'findOne',
  'findById',
  'countDocuments',
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'distinct',
]);

function anyTenant<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (typeof prop === 'string' && QUERY_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const query = (value as (...a: unknown[]) => { setOptions: (o: object) => unknown }).apply(
            target,
            args,
          );
          return query.setOptions({ allowCrossTenant: true });
        };
      }
      if (prop === 'aggregate') {
        return (...args: unknown[]) => {
          const agg = (value as (...a: unknown[]) => { option: (o: object) => unknown }).apply(target, args);
          return agg.option({ allowCrossTenant: true });
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

export const AnalystReviewModel = anyTenant(RealAnalystReviewModel);
export const CounterNarrativeModel = anyTenant(RealCounterNarrativeModel);
export const DispatchModel = anyTenant(RealDispatchModel);
export const InviteModel = anyTenant(RealInviteModel);
export const NarrativeReviewModel = anyTenant(RealNarrativeReviewModel);
