import { HealthSchema, type ModelHealth } from '../contracts/model/multilabelV1.js';
import { modelHeaders, readErrorDetail } from './modelHttp.js';
import type { HealthSource } from './modelStatus.js';

export class HttpHealthSource implements HealthSource {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly apiKey: string | null = null,
  ) {}

  async fetchHealth(): Promise<ModelHealth> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/health`, {
      headers: modelHeaders(this.apiKey),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // The model may answer warming with 503; the body still carries the health payload.
    const raw = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const parsed = HealthSchema.safeParse(body);
    if (!parsed.success) {
      // e.g. 401/403 from a wrong key: say what the service said (FastAPI: {"detail": "..."})
      const detail = res.ok ? '' : await readErrorDetail(new Response(raw));
      throw new Error(
        `GET /v1/health returned HTTP ${res.status}${detail ? `: ${detail}` : ' with an invalid body'}`,
      );
    }
    return parsed.data;
  }
}
