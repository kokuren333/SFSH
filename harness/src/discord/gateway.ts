/**
 * Minimal Discord gateway v10 client (WP-4.4). Enough to receive INTERACTION_CREATE:
 *   HELLO (op 10) → heartbeat loop (op 1 with the last sequence; first beat after interval × jitter) + IDENTIFY (op 2,
 *   intents 0 — interactions need no intent) · HEARTBEAT_ACK (op 11) · server heartbeat request (op 1) · DISPATCH (op 0)
 *   READY / INTERACTION_CREATE → callbacks · RECONNECT (op 7) / INVALID_SESSION (op 9) / unexpected close / missed ACK
 *   → simple reconnect with a fresh IDENTIFY (no RESUME; a missed interaction during the gap simply gets no reply).
 * The socket and the timers are injectable: tests drive a fake socket, nothing touches the network.
 * The token is only ever placed in the IDENTIFY payload; it is never logged.
 */

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => GatewaySocket;

export interface GatewayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export const realTimers: GatewayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as GatewaySocket;

export interface GatewayOptions {
  url: string;
  token: string;
  intents?: number;
  socketFactory?: SocketFactory;
  timers?: GatewayTimers;
  random?: () => number;
  reconnectDelayMs?: number;
  onInteraction: (interaction: unknown) => void | Promise<void>;
  onReady?: (d: { session_id?: string; user?: { id?: string; username?: string } }) => void;
  /** Close codes that end the client (bad token, bad intents…). */
  onFatal?: (code: number, reason: string) => void;
  log?: (msg: string) => void;
}

export interface GatewayClient {
  start(): void;
  stop(): void;
  readonly connects: number;
  readonly sequence: number | null;
}

/** Discord close codes after which reconnecting is pointless (4004 auth failed, 4010–4014 shard/intents). */
export const FATAL_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];

export const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

function asText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

export function createGateway(opts: GatewayOptions): GatewayClient {
  const timers = opts.timers ?? realTimers;
  const factory = opts.socketFactory ?? defaultSocketFactory;
  const random = opts.random ?? Math.random;
  const log = opts.log ?? (() => {});
  const reconnectDelay = opts.reconnectDelayMs ?? 1000;

  let ws: GatewaySocket | null = null;
  let seq: number | null = null;
  let acked = true;
  let hbFirst: unknown = null;
  let hbLoop: unknown = null;
  let reconnectTimer: unknown = null;
  let stopped = true;
  let connects = 0;

  const send = (sock: GatewaySocket, payload: unknown) => {
    try {
      sock.send(JSON.stringify(payload));
    } catch (e) {
      log(`gateway: send failed: ${(e as Error).message}`);
    }
  };

  function clearHeartbeat() {
    if (hbFirst !== null) timers.clearTimeout(hbFirst);
    if (hbLoop !== null) timers.clearInterval(hbLoop);
    hbFirst = hbLoop = null;
  }

  function teardown(code: number) {
    clearHeartbeat();
    const sock = ws;
    ws = null;
    if (sock) {
      sock.onmessage = sock.onclose = sock.onerror = sock.onopen = null;
      try {
        sock.close(code);
      } catch {
        /* already closed */
      }
    }
  }

  function scheduleConnect(delay: number) {
    if (stopped) return;
    if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function reconnect(why: string, delay = reconnectDelay) {
    log(`gateway: reconnect (${why})`);
    teardown(4000); // non-1000 code: Discord keeps the session resumable (we re-identify anyway)
    seq = null;
    scheduleConnect(delay);
  }

  function beat(sock: GatewaySocket) {
    if (sock !== ws) return;
    if (!acked) {
      reconnect("heartbeat not acknowledged");
      return;
    }
    acked = false;
    send(sock, { op: OP.HEARTBEAT, d: seq });
  }

  function onMessage(sock: GatewaySocket, raw: unknown) {
    if (sock !== ws) return;
    let p: { op?: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      p = JSON.parse(asText(raw)) as typeof p;
    } catch {
      log("gateway: non-JSON frame ignored");
      return;
    }
    if (typeof p.s === "number") seq = p.s;
    switch (p.op) {
      case OP.HELLO: {
        const interval = Number((p.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval <= 0) {
          reconnect("bad HELLO");
          return;
        }
        clearHeartbeat();
        acked = true;
        hbFirst = timers.setTimeout(() => {
          hbFirst = null;
          beat(sock);
          if (sock === ws) hbLoop = timers.setInterval(() => beat(sock), interval);
        }, Math.floor(interval * random()));
        send(sock, { op: OP.IDENTIFY, d: { token: opts.token, intents: opts.intents ?? 0, properties: { os: process.platform, browser: "sfsh", device: "sfsh" } } });
        return;
      }
      case OP.HEARTBEAT_ACK:
        acked = true;
        return;
      case OP.HEARTBEAT:
        send(sock, { op: OP.HEARTBEAT, d: seq });
        return;
      case OP.DISPATCH:
        if (p.t === "READY") {
          log("gateway: READY");
          opts.onReady?.((p.d ?? {}) as Parameters<NonNullable<GatewayOptions["onReady"]>>[0]);
        } else if (p.t === "INTERACTION_CREATE") {
          Promise.resolve()
            .then(() => opts.onInteraction(p.d))
            .catch((e) => log(`gateway: interaction callback failed: ${(e as Error).message}`));
        }
        return;
      case OP.RECONNECT:
        reconnect("op 7 RECONNECT");
        return;
      case OP.INVALID_SESSION:
        reconnect("op 9 INVALID_SESSION", 1000 + Math.floor(random() * 4000));
        return;
      default:
        return;
    }
  }

  function connect() {
    if (stopped) return;
    connects++;
    const sock = factory(opts.url);
    ws = sock;
    acked = true;
    sock.onmessage = (ev) => onMessage(sock, ev.data);
    sock.onerror = () => log("gateway: socket error");
    sock.onclose = (ev) => {
      if (sock !== ws) return;
      const code = ev?.code ?? 0;
      if (FATAL_CLOSE_CODES.includes(code)) {
        log(`gateway: fatal close ${code}`);
        stopped = true;
        teardown(1000);
        opts.onFatal?.(code, ev?.reason ?? "");
        return;
      }
      reconnect(`closed ${code}`);
    };
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      teardown(1000);
    },
    get connects() {
      return connects;
    },
    get sequence() {
      return seq;
    },
  };
}
