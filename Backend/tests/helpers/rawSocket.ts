/**
 * A minimal Socket.IO v4 client over the real WebSocket transport (Node's built-in WebSocket), so the e2e test
 * exercises the real wire path without adding a dependency.
 *   engine.io: "0{...}" open, "2" ping -> reply "3";  socket.io: "40" connect, "42[event,payload]" event.
 */
export interface RawSocket {
  events: Array<{ name: string; payload: unknown }>;
  ofType(name: string): unknown[];
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until the predicate is true; throws a readable error on timeout. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 15_000,
    intervalMs = 50,
    what = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** `token` is the access token, sent as the Socket.IO connect `auth` payload. Without one the server refuses. */
export function connectSocket(port: number, token?: string): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const events: RawSocket['events'] = [];
    let connected = false;

    const socket: RawSocket = {
      events,
      ofType: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
      waitFor: (predicate, timeoutMs = 15_000) => waitUntil(predicate, { timeoutMs, what: 'a socket event' }),
      close: () => ws.close(),
    };

    ws.onerror = () => reject(new Error('socket.io websocket error'));
    ws.onmessage = (msg) => {
      const data = String(msg.data);
      if (data.startsWith('0'))
        ws.send(token ? `40${JSON.stringify({ token })}` : '40'); // engine.io open -> connect to the default namespace
      else if (data === '2')
        ws.send('3'); // ping -> pong
      else if (data.startsWith('40')) {
        connected = true;
        resolve(socket);
      } else if (data.startsWith('42')) {
        const [name, payload] = JSON.parse(data.slice(2)) as [string, unknown];
        events.push({ name, payload });
      } else if (data.startsWith('44')) reject(new Error(`socket.io connect refused: ${data}`));
    };
    setTimeout(() => {
      if (!connected) reject(new Error('socket.io connect timed out'));
    }, 5000).unref();
  });
}
