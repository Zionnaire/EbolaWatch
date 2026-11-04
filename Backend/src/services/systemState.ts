import type { OperatingMode } from '../contracts/api/index.js';
import { OperatingModeSchema } from '../contracts/api/index.js';
import { SystemStateModel } from '../models/SystemState.js';

export interface SystemStateRepo {
  load(): Promise<OperatingMode | null>;
  save(mode: OperatingMode, by: string | null): Promise<void>;
}

export class MongoSystemStateRepo implements SystemStateRepo {
  async load(): Promise<OperatingMode | null> {
    const doc = await SystemStateModel.findOne({ key: 'singleton' }).lean();
    const parsed = OperatingModeSchema.safeParse(doc?.operatingMode);
    return parsed.success ? parsed.data : null;
  }
  async save(mode: OperatingMode, by: string | null): Promise<void> {
    await SystemStateModel.updateOne(
      { key: 'singleton' },
      { $set: { operatingMode: mode, updatedAt: new Date(), updatedBy: by } },
      { upsert: true },
    );
  }
}

export class MemorySystemStateRepo implements SystemStateRepo {
  constructor(private mode: OperatingMode | null = null) {}
  load(): Promise<OperatingMode | null> {
    return Promise.resolve(this.mode);
  }
  save(mode: OperatingMode): Promise<void> {
    this.mode = mode;
    return Promise.resolve();
  }
}

/** The operating mode, persisted. `mode()` is synchronous (cached) so status building stays cheap. */
export class SystemStateService {
  private current: OperatingMode = 'dormant';

  constructor(private readonly repo: SystemStateRepo) {}

  async init(): Promise<void> {
    const stored = await this.repo.load();
    if (stored) this.current = stored;
    else await this.repo.save(this.current, null); // first boot: persist the default
  }

  mode(): OperatingMode {
    return this.current;
  }

  async setMode(mode: OperatingMode, by: string): Promise<OperatingMode> {
    await this.repo.save(mode, by);
    this.current = mode;
    return mode;
  }
}
