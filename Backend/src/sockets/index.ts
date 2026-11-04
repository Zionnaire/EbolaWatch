import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { ACCESS_COOKIE, parseCookies } from '../auth/cookies.js';
import type { PrincipalLoader } from '../auth/principalLoader.js';
import { tenantCanSeePost, type PostAudience, type SocketTenant } from '../auth/scope.js';
import type { ModelStatusStore } from '../classifier/modelStatus.js';
import type { ClassifierAlert } from '../classifier/types.js';
import type { Config } from '../config.js';
import type { ClientToServerEvents, PostDto, ServerToClientEvents } from '../contracts/api/index.js';
import { verifyToken } from '../utils/jwt.js';
import { logger } from '../utils/logger.js';

/** What a socket carries after it has authenticated. Never trusted from the client. */
export interface SocketData {
  userId: string;
  tenant: SocketTenant;
}

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** Same origin lock as the REST API: only FRONTEND_URL may connect. */
export function createSocketServer(
  httpServer: HttpServer,
  config: Pick<Config, 'FRONTEND_URL'>,
): TypedServer {
  return new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    { cors: { origin: config.FRONTEND_URL, credentials: true } },
  );
}

export const ROOM_ALL = 'all';
export const orgRoom = (organizationId: string) => `org:${organizationId}`;
export const userRoom = (userId: string) => `user:${userId}`;

/**
 * Connections must be authenticated, with the same session as the REST API: the HttpOnly cookie (sent by the browser
 * on the handshake) or `auth: { token }`. The user and organization are loaded from the database, so a suspended
 * organization or a disabled user cannot connect. Each socket joins `all`, its organization's room and its own.
 */
export function attachSocketAuth(
  io: TypedServer,
  deps: { jwtSecret: string; loader: PrincipalLoader },
): void {
  io.use(async (socket, next) => {
    try {
      const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const token =
        (typeof fromAuth === 'string' ? fromAuth : null) ??
        parseCookies(socket.handshake.headers.cookie)[ACCESS_COOKIE] ??
        null;
      if (!token) return next(new Error('unauthorized'));
      const claims = verifyToken(token, deps.jwtSecret, 'access');
      const p = await deps.loader.load(claims.sub, claims.tv);
      socket.data = {
        userId: p.userId,
        tenant: {
          platformWide: p.org === null,
          organizationId: p.organizationId,
          scopeStates: p.org?.scopeStates ?? [],
        },
      };
      return next();
    } catch {
      return next(new Error('unauthorized')); // one answer for every failure; no detail for an attacker
    }
  });

  io.on('connection', (socket) => {
    void socket.join([ROOM_ALL, userRoom(socket.data.userId)]);
    if (socket.data.tenant.organizationId) void socket.join(orgRoom(socket.data.tenant.organizationId));
  });
}

/** Thin typed facade so services never depend on socket.io directly (and tests can fake it). */
export interface Broadcaster {
  /** To every authenticated connection (model status, system updates, alerts: platform-level facts). */
  emit<E extends keyof ServerToClientEvents>(event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  /** A classified post goes only to the connections whose organization may see it. */
  emitPost(post: PostDto, audience: PostAudience): void;
  /** Drops live connections at once (a suspended organization, a disabled user). */
  disconnectOrg(organizationId: string): void;
  disconnectUser(userId: string): void;
}

export function toBroadcaster(io: TypedServer): Broadcaster {
  return {
    emit: (event, ...args) => {
      // the generic spread is safe: callers pass exactly the payload type of `event`
      (io.to(ROOM_ALL) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
    },
    emitPost: (post, audience) => {
      void io
        .in(ROOM_ALL)
        .fetchSockets()
        .then((sockets) => {
          for (const s of sockets)
            if (tenantCanSeePost(s.data.tenant, audience)) s.emit('post:classified', post);
        })
        .catch((err) => logger.warn({ err }, 'could not deliver post:classified'));
    },
    disconnectOrg: (organizationId) => void io.in(orgRoom(organizationId)).disconnectSockets(true),
    disconnectUser: (userId) => void io.in(userRoom(userId)).disconnectSockets(true),
  };
}

export function wireModelStatus(store: ModelStatusStore, b: Pick<Broadcaster, 'emit'>): void {
  store.on('change', (s: ReturnType<ModelStatusStore['get']>) =>
    b.emit('model:status', {
      modelStatus: s.status,
      modelVersion: s.modelVersion,
      taxonomyVersion: s.taxonomyVersion,
      retryAvailableAt: s.retryAvailableAt,
    }),
  );
}

export function emitAlert(b: Pick<Broadcaster, 'emit'>, a: ClassifierAlert): void {
  b.emit('alert', {
    id: randomUUID(),
    level: a.level,
    code: a.code,
    message: a.message,
    at: new Date().toISOString(),
  });
}
