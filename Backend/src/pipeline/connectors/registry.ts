import type { ConnectorDto } from '../../contracts/api/index.js';
import { ConnectorModel } from '../../models/Connector.js';
import type { Connector } from './types.js';

// TODO(ext): real platform connectors run in the Python / HuggingFace service and push posts to POST /api/ingest.
// The text below is what people see in Settings, so it says what is true without development jargon.
const NOT_INTEGRATED_DETAIL =
  'Not connected yet. Posts from this platform will arrive through the ingestion service once it is set up.';

/** Placeholder for a platform whose connector is not built yet. Registered so the UI can show it honestly. */
export class NotIntegratedConnector implements Connector {
  readonly initialStatus = 'not_integrated' as const;
  readonly initialDetail = NOT_INTEGRATED_DETAIL;
  constructor(
    readonly key: string,
    readonly name: string,
    readonly platform: string,
  ) {}
}

export const platformStubs = (): Connector[] => [
  new NotIntegratedConnector('bluesky', 'Bluesky', 'bluesky'),
  new NotIntegratedConnector('youtube', 'YouTube', 'youtube'),
  new NotIntegratedConnector('twitter', 'X (Twitter)', 'x'),
  new NotIntegratedConnector('instagram', 'Instagram', 'instagram'),
];

export class PushApiConnector implements Connector {
  readonly key = 'push-api';
  readonly name = 'Push API (POST /api/ingest)';
  readonly platform = 'any';
  readonly initialStatus: Connector['initialStatus'];
  readonly initialDetail = 'Accepts posts from external connectors, protected by INGEST_API_KEY.';
  constructor(enabled: boolean) {
    this.initialStatus = enabled ? 'live' : 'paused';
  }
}

/** Connector status is data: seeded once, then owned by the DB. */
export class ConnectorService {
  constructor(private readonly connectors: Connector[]) {}

  async seed(): Promise<void> {
    await ConnectorModel.bulkWrite(
      this.connectors.map((c) => ({
        updateOne: {
          filter: { key: c.key },
          update: {
            $setOnInsert: {
              key: c.key,
              name: c.name,
              platform: c.platform,
              status: c.initialStatus,
              detail: c.initialDetail,
              lastRunAt: null,
            },
          },
          upsert: true,
        },
      })),
    );
    // placeholders have no state of their own, so a reworded detail reaches rows created by an earlier version
    await ConnectorModel.bulkWrite(
      this.connectors
        .filter((c) => c.initialStatus === 'not_integrated')
        .map((c) => ({
          updateOne: {
            filter: { key: c.key, status: 'not_integrated' },
            update: { $set: { detail: c.initialDetail } },
          },
        })),
    );
  }

  /** The connector's configured enabled/paused state follows the current ingestion mode on every boot. */
  async setStatus(key: string, status: 'live' | 'paused'): Promise<void> {
    await ConnectorModel.updateOne({ key, status: { $in: ['live', 'paused'] } }, { $set: { status } });
  }

  async markRun(key: string, outcome: { ok: true } | { ok: false; detail: string }): Promise<void> {
    if (outcome.ok) {
      await ConnectorModel.updateOne({ key }, { $set: { lastRunAt: new Date() } });
      await ConnectorModel.updateOne({ key, status: 'error' }, { $set: { status: 'live', detail: null } });
    } else {
      await ConnectorModel.updateOne({ key }, { $set: { status: 'error', detail: outcome.detail } });
    }
  }

  async list(): Promise<ConnectorDto[]> {
    const docs = await ConnectorModel.find().sort({ key: 1 }).lean();
    return docs.map((d) => ({
      id: d.key,
      name: d.name,
      platform: d.platform,
      status: d.status,
      detail: d.detail ?? null,
      lastRunAt: d.lastRunAt ? d.lastRunAt.toISOString() : null,
    }));
  }
}
