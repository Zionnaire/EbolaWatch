import path from 'node:path';
import type { Response } from 'express';
import { createApp } from './app.js';
import { authenticate } from './auth/middleware.js';
import { currentPrincipal } from './auth/middleware.js';
import { PrincipalLoader } from './auth/principalLoader.js';
import { tenantFromPrincipal, type Scope } from './auth/scope.js';
import type { PlatformDefaults } from './auth/types.js';
import { buildClassifierStack } from './classifier/index.js';
import { classifierKnownMock } from './classifier/provenance.js';
import type { Config } from './config.js';
import { ingestKey } from './middlewares/ingestKey.js';
import { authRateLimiter } from './middlewares/rateLimiter.js';
import { MongoRulesRepo } from './models/RulesConfig.js';
import { MongoTaxonomyRepo } from './models/Taxonomy.js';
import { IngestService } from './pipeline/ingest.js';
import { MockConnector } from './pipeline/connectors/mockConnector.js';
import { ConnectorService, PushApiConnector, platformStubs } from './pipeline/connectors/registry.js';
import { PipelineService } from './pipeline/pipeline.js';
import { WorkQueue } from './pipeline/queue.js';
import { AnalyticsService } from './services/analytics/analyticsService.js';
import { DispatchService, MockDispatcher, type Dispatcher } from './services/narratives/dispatchService.js';
import type { CounterNarrativeGenerator } from './services/narratives/generator.js';
import { MockGenerator } from './services/narratives/mockGenerator.js';
import { FactBase } from './knowledge/factBase.js';
import { GroqClient } from './services/narratives/groqClient.js';
import {
  GroqNarrativeRefiner,
  NoRefiner,
  type NarrativeRefiner,
} from './services/analytics/narrativeRefiner.js';
import { GroqRagGenerator } from './services/narratives/ragGenerator.js';
import { NarrativeService } from './services/narratives/narrativeService.js';
import { PlatformLimits, type PlatformConfig } from './services/narratives/platforms.js';
import { PostQueryService } from './services/postQueries.js';
import { ReviewService } from './services/review.js';
import { RulesService } from './services/rules.js';
import { runIsMock } from './services/runScope.js';
import { MongoSystemStateRepo, SystemStateService } from './services/systemState.js';
import { buildSystemStatus } from './services/systemStatus.js';
import { AuthService } from './services/tenancy/authService.js';
import { OrganizationService } from './services/tenancy/organizationService.js';
import { UserService } from './services/tenancy/userService.js';
import { emitAlert, wireModelStatus, type Broadcaster } from './sockets/index.js';
import { logger } from './utils/logger.js';

export interface ApplicationOptions {
  /** Interval for the synthetic feed. */
  mockIntervalMs?: number;
  mockBatchSize?: number;
  sweepIntervalMs?: number;
  /** Replace the mock generator / dispatcher (tests, or the real ones once they exist). */
  generator?: CounterNarrativeGenerator;
  /** Narrative merging/naming (tests); built from CLUSTER_REFINER otherwise. */
  refiner?: NarrativeRefiner;
  /** The fact base (tests); loaded from KNOWLEDGE_FILE when the Groq writer is on. */
  facts?: FactBase;
  dispatcher?: Dispatcher;
  platforms?: PlatformConfig[];
  /** Override the sign-in rate limit (tests). */
  authRateLimitPerMinute?: number;
}

/**
 * Composition root: builds every service once and wires them together. Used by index.ts and by the
 * integration tests (which pass an in-memory broadcaster and an in-memory MongoDB).
 * Requires an open Mongoose connection.
 */
export async function buildApplication(
  config: Config,
  broadcaster: Broadcaster,
  options: ApplicationOptions = {},
) {
  const stack = buildClassifierStack(config, new MongoTaxonomyRepo(), (a) => emitAlert(broadcaster, a));
  wireModelStatus(stack.store, broadcaster);

  const state = new SystemStateService(new MongoSystemStateRepo());
  await state.init();

  // Both stages are mocked until real ones exist; their `mode` is what /api/system/status reports.
  // The fact base is required when Groq writes; otherwise it is loaded only so Settings can show it.
  const facts = loadFacts(config, options.facts);
  const generator: CounterNarrativeGenerator =
    options.generator ??
    (config.GENERATOR_MODE === 'groq' && facts
      ? new GroqRagGenerator(
          new GroqClient({
            apiKey: config.GROQ_API_KEY!,
            model: config.GROQ_MODEL,
            baseUrl: config.GROQ_BASE_URL,
            timeoutMs: config.GROQ_TIMEOUT_MS,
          }),
          facts,
          { requireReviewedFacts: config.KNOWLEDGE_REQUIRE_REVIEW },
        )
      : new MockGenerator());
  const dispatcher: Dispatcher = options.dispatcher ?? new MockDispatcher();

  const getStatus = () =>
    buildSystemStatus({
      config,
      store: stack.store,
      classifier: stack.client,
      identity: stack.identity,
      operatingMode: () => state.mode(),
      generator: generator.mode,
      dispatcher: dispatcher.mode,
    });
  /** The model's identity so far: from a classify response, else from /v1/health's version. */
  const currentIdentity = () =>
    stack.identity.current ??
    (stack.store.get().modelVersion ? { name: '', version: stack.store.get().modelVersion! } : null);
  /** The current run's isMock: stamped on new data, and every read is scoped to it. */
  const runMock = () => runIsMock(getStatus().dataSource);

  // ---- tenancy: who is calling, and which data they may touch -----------------------------------------------
  /** What an organization inherits when it has not set a value of its own. */
  const platformDefaults: PlatformDefaults = {
    overdueHours: config.OVERDUE_HOURS,
    queueCap: config.QUEUE_CAP,
    vocabulary: {},
  };
  const loader = new PrincipalLoader();
  const authenticateRequest = authenticate({ jwtSecret: config.JWT_SECRET, loader });
  /** The scope of one request: this run (mock/real) AND this caller's tenant. */
  const scope = (res: Response): Scope => ({
    isMock: runMock(),
    tenant: tenantFromPrincipal(currentPrincipal(res), platformDefaults),
  });

  const cookies = {
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshTtlSeconds: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
  };
  const authService = new AuthService({
    jwtSecret: config.JWT_SECRET,
    accessTtlSeconds: cookies.accessTtlSeconds,
    refreshTtlSeconds: cookies.refreshTtlSeconds,
    loader,
    defaults: platformDefaults,
  });
  const organizations = new OrganizationService({
    defaults: platformDefaults,
    frontendUrl: config.FRONTEND_URL,
    loader,
    // a suspended organization is cut off everywhere at once, including live connections
    onSuspended: (organizationId) => broadcaster.disconnectOrg(organizationId),
  });
  const users = new UserService({
    frontendUrl: config.FRONTEND_URL,
    loader,
    onUserChanged: (userId) => broadcaster.disconnectUser(userId),
  });
  const authLimiter = authRateLimiter(options.authRateLimitPerMinute ?? config.AUTH_RATE_LIMIT_PER_MINUTE);

  // ---- pipeline ---------------------------------------------------------------------------------------------
  const rules = new RulesService(new MongoRulesRepo());
  const pipeline = new PipelineService({
    classifier: stack.client,
    rules,
    taxonomy: stack.taxonomy,
    getMode: () => state.mode(),
    classifierProvenance: () => getStatus().dataSource.classifier,
    broadcaster,
    overdueHours: config.OVERDUE_HOURS,
  });
  const queue = new WorkQueue({
    cap: config.QUEUE_CAP,
    batchSize: 32,
    handler: (ids) => pipeline.processBatch(ids),
    onDrained: async () => void (await pipeline.sweep()),
  });
  pipeline.attachQueue(queue);

  const ingest = new IngestService({
    authorHashSecret: config.AUTHOR_HASH_SECRET,
    // Provisional stamp: synthetic origin, or a classifier already known to be mock. Corrected at classification.
    isMock: () =>
      config.INGESTION_MODE === 'mock' ||
      classifierKnownMock(stack.client.kind, currentIdentity(), config.MODEL_MOCK_MARKER),
    originIsMock: () => config.INGESTION_MODE === 'mock',
    enqueue: (id) => queue.enqueue(id),
  });

  const mockEnabled = config.INGESTION_MODE === 'mock';
  const mock = new MockConnector(
    ingest,
    {
      intervalMs: options.mockIntervalMs ?? 10_000,
      batchSize: options.mockBatchSize ?? 3,
      onRun: (o) =>
        void connectors
          .markRun('mock', o.ok ? { ok: true } : { ok: false, detail: String(o.error) })
          .catch((err) => logger.warn({ err }, 'could not record connector run')),
    },
    mockEnabled,
  );
  const connectors = new ConnectorService([mock, new PushApiConnector(!mockEnabled), ...platformStubs()]);

  const queries = new PostQueryService({ overdueHours: config.OVERDUE_HOURS });
  const reviews = new ReviewService(stack.taxonomy);

  const platforms = new PlatformLimits(options.platforms);
  const narratives = new NarrativeService({ generator, platforms, taxonomy: stack.taxonomy });
  const dispatch = new DispatchService({ dispatcher });
  const refiner: NarrativeRefiner =
    options.refiner ??
    (config.CLUSTER_REFINER === 'ai'
      ? new GroqNarrativeRefiner(
          new GroqClient({
            apiKey: config.GROQ_API_KEY!,
            model: config.GROQ_MODEL,
            baseUrl: config.GROQ_BASE_URL,
            timeoutMs: config.GROQ_TIMEOUT_MS,
          }),
        )
      : new NoRefiner());
  const analytics = new AnalyticsService({
    queueCap: config.QUEUE_CAP,
    overdueHours: config.OVERDUE_HOURS,
    refiner,
    clusterCacheMs: config.NODE_ENV === 'test' ? 0 : 30_000,
  });

  const app = createApp(config, {
    system: { getStatus, taxonomy: stack.taxonomy },
    auth: { auth: authService, cookies, authenticate: authenticateRequest, authLimiter },
    tenancy: { organizations, users, authenticate: authenticateRequest },
    api: {
      posts: { queries, reviews, scope },
      admin: { state, pipeline, rules, connectors, getStatus, scope, broadcaster },
      narratives: { narratives, dispatch, platforms, generator, dispatcher, scope },
      analytics: { analytics, scope },
      ingest,
      knowledge: () => facts?.toDto() ?? null,
      authenticate: authenticateRequest,
      ingestKey: ingestKey(config.INGEST_API_KEY),
    },
  });

  let sweepTimer: NodeJS.Timeout | null = null;

  return {
    app,
    getStatus,
    /** The current run's mock/real flag (platform-level, not tenant-level). */
    runMock,
    pipeline,
    queue,
    ingest,
    mock,
    state,
    stack,
    rules,
    connectors,
    narratives,
    dispatch,
    analytics,
    generator,
    dispatcher,
    loader,
    authService,
    organizations,
    users,
    /** What Socket.io needs to authenticate a connection the same way the REST API does. */
    socketAuth: { jwtSecret: config.JWT_SECRET, loader },

    /** Seeds data, syncs the taxonomy, rebuilds the queue from the DB and starts background work. */
    async start() {
      await connectors.seed();
      // the enabled/paused state of the two feeds follows INGESTION_MODE on every boot
      await connectors.setStatus('mock', mockEnabled ? 'live' : 'paused');
      await connectors.setStatus('push-api', mockEnabled ? 'paused' : 'live');

      await stack.taxonomy.init();
      const known = stack.taxonomy.knownCategoryIds();
      await rules.getFor(config.MODEL_CONTRACT, stack.taxonomy.version(), known ? [...known] : undefined);

      // First poll before anything is classified: it also tells us the model's version (provenance)
      await stack.poller.poll();
      stack.poller.start();
      const requeued = await pipeline.rebuildQueue();
      logger.info({ requeued }, 'queue rebuilt from the database');

      sweepTimer = setInterval(
        () => void pipeline.sweep().catch((err) => logger.warn({ err }, 'sweep failed')),
        options.sweepIntervalMs ?? 60_000,
      );
      sweepTimer.unref();
      if (mockEnabled) mock.start();
    },

    async stop() {
      mock.stop();
      if (sweepTimer) clearInterval(sweepTimer);
      stack.poller.stop();
      pipeline.stop();
      queue.stop();
      await queue.idle().catch(() => undefined);
    },
  };
}

export type Application = Awaited<ReturnType<typeof buildApplication>>;

function loadFacts(config: Config, provided: FactBase | undefined): FactBase | null {
  if (provided) return provided;
  try {
    return FactBase.fromFile(path.resolve(config.KNOWLEDGE_FILE));
  } catch (err) {
    // Groq cannot write without facts, so that is fatal; the mock writer does not need them.
    if (config.GENERATOR_MODE === 'groq') throw err;
    return null;
  }
}
