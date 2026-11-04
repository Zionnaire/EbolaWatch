/**
 * One-off, idempotent backfill for data written before multi-tenancy existed.
 *
 *   pnpm migrate:tenancy --dry-run            report what would change
 *   pnpm migrate:tenancy                      apply the safe changes
 *   pnpm migrate:tenancy --assign-org <slug>  also give orphaned tenant-owned records to that organization
 *
 * Safe changes: posts get an explicit `visibility: "global"`, an empty `orgState` and `originMock`.
 * Records that must belong to a tenant (reviews, counter-narratives, dispatches) cannot be guessed: they are only
 * reported, unless you name the organization that should own them.
 * Uses the native driver on purpose, so the tenant guard does not apply to a platform maintenance job.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';

const TENANT_COLLECTIONS = ['analystreviews', 'narrativereviews', 'counternarratives', 'dispatches'];

async function main() {
  const config = loadConfig();
  const dry = process.argv.includes('--dry-run');
  const slugAt = process.argv.indexOf('--assign-org');
  const slug = slugAt >= 0 ? process.argv[slugAt + 1] : undefined;

  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB });
  const db = mongoose.connection.db!;
  console.log(`${dry ? '[dry run] ' : ''}database "${config.MONGODB_DB}"`);

  const posts = db.collection('posts');
  const fixes: Array<[string, object, object]> = [
    [
      'visibility = "global"',
      { visibility: { $exists: false } },
      { $set: { visibility: 'global', organizationId: null } },
    ],
    ['orgState = {}', { orgState: { $exists: false } }, { $set: { orgState: {} } }],
  ];
  for (const [label, filter, update] of fixes) {
    const n = await posts.countDocuments(filter);
    if (!dry && n > 0) await posts.updateMany(filter, update);
    console.log(`posts missing ${label}: ${n}${dry ? '' : ' (fixed)'}`);
  }
  // originMock: rows that predate the field were stamped mock only when synthetic or mock-classified; keep that flag
  const noOrigin = await posts.countDocuments({ originMock: { $in: [null] } });
  if (!dry && noOrigin > 0) {
    await posts.updateMany({ originMock: { $in: [null] } }, [{ $set: { originMock: '$isMock' } }]);
  }
  console.log(`posts missing originMock: ${noOrigin}${dry ? '' : ' (copied from isMock)'}`);

  let orgId: mongoose.Types.ObjectId | null = null;
  if (slug) {
    const org = await db.collection('organizations').findOne({ slug });
    if (!org) throw new Error(`No organization with slug "${slug}"`);
    orgId = org._id as unknown as mongoose.Types.ObjectId;
  }
  for (const name of TENANT_COLLECTIONS) {
    const filter = { organizationId: { $in: [null] } };
    const n = await db.collection(name).countDocuments(filter);
    if (n === 0) continue;
    if (orgId && !dry) {
      await db.collection(name).updateMany(filter, { $set: { organizationId: orgId } });
      console.log(`${name} without an owner: ${n} (assigned to "${slug}")`);
    } else {
      console.log(`${name} without an owner: ${n} (NOT changed; use --assign-org <slug>)`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
