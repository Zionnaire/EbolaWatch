import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@/contracts';
import { SOCKET_URL } from '@/env';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * One connection for the whole app. The session cookie authenticates the handshake, exactly like the REST API,
 * so this is only opened while someone is signed in (see useLiveSync).
 */
export function createSocket(): AppSocket {
  return io(SOCKET_URL, {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    autoConnect: false,
    reconnectionDelayMax: 10_000,
  });
}
