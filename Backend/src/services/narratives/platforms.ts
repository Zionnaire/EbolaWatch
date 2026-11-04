export interface PlatformConfig {
  id: string;
  name: string;
  /** Maximum characters of a single post/comment on that platform. */
  charLimit: number;
}

/**
 * Platform character limits are configuration. Ids match `Post.platform`.
 * TODO(ext): move to the DB (editable) if NCDC needs to change them without a deploy.
 */
export const DEFAULT_PLATFORMS: PlatformConfig[] = [
  { id: 'x', name: 'X (Twitter)', charLimit: 280 },
  { id: 'bluesky', name: 'Bluesky', charLimit: 300 },
  { id: 'instagram', name: 'Instagram', charLimit: 2200 },
  { id: 'youtube', name: 'YouTube', charLimit: 10_000 },
];

export class PlatformLimits {
  private readonly byId: Map<string, PlatformConfig>;

  constructor(platforms: PlatformConfig[] = DEFAULT_PLATFORMS) {
    this.byId = new Map(platforms.map((p) => [p.id.toLowerCase(), p]));
  }

  get(id: string): PlatformConfig | null {
    return this.byId.get(id.trim().toLowerCase()) ?? null;
  }

  list(): PlatformConfig[] {
    return [...this.byId.values()];
  }
}
