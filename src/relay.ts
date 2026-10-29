#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_THREAD, NAME_PATTERN, THREAD_PATTERN } from "./config.js";

export const VERSION = "0.2.0";

export interface Message {
  id: number;
  from: string;
  to: string; // a peer name, or "all"
  thread: string;
  body: string;
  ts: string;
}

export interface ThreadSummary {
  thread: string;
  participants: string[];
  messages: number;
  unread: number;
  last: { id: number; from: string; ts: string; preview: string };
}

interface State {
  nextId: number;
  messages: Message[];
  // Last consumed message id. "<name>#<thread>" is per thread; a bare "<name>"
  // key is a floor across all threads (written by pre-thread relay versions).
  cursors: Record<string, number>;
  peers: Record<string, string>; // name -> last seen ISO time
}

export interface RelayOptions {
  token: string;
  dataFile?: string;
  maxMessages?: number;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
}

const MAX_WAIT_SECONDS = 120;

export function createRelay(opts: RelayOptions): Server {
  const maxMessages = opts.maxMessages ?? 2000;
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024;
  const rateLimit = opts.rateLimitPerMinute ?? 120;
  const tokenHash = createHash("sha256").update(opts.token).digest();

  const state: State = loadState(opts.dataFile);
  const waiters = new Map<string, Set<() => void>>();
  const hits = new Map<string, { windowStart: number; count: number }>();

  let saveTimer: NodeJS.Timeout | undefined;
  function persist(): void {
    if (!opts.dataFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const tmp = `${opts.dataFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, opts.dataFile!);
    }, 200);
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const presentedHash = createHash("sha256").update(presented).digest();
    return timingSafeEqual(presentedHash, tokenHash);
  }

  function rateLimited(key: string): boolean {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      hits.set(key, { windowStart: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > rateLimit;
  }

  function readUpTo(name: string, thread: string): number {
    return Math.max(state.cursors[name] ?? 0, state.cursors[`${name}#${thread}`] ?? 0);
  }

  // `threads` limits the result to those threads; undefined means every thread.
  function unreadFor(name: string, threads?: Set<string>): Message[] {
    return state.messages.filter(
      (m) =>
        m.from !== name &&
        (m.to === name || m.to === "all") &&
        (!threads || threads.has(m.thread)) &&
        m.id > readUpTo(name, m.thread),
    );
  }

  function markRead(name: string, messages: Message[]): void {
    for (const m of messages) {
      const key = `${name}#${m.thread}`;
      state.cursors[key] = Math.max(state.cursors[key] ?? 0, m.id);
    }
    persist();
  }

  function threadsFor(name: string): ThreadSummary[] {
    const byThread = new Map<string, { participants: Set<string>; messages: Message[] }>();
    for (const m of state.messages) {
      if (m.from !== name && m.to !== name && m.to !== "all") continue;
      let entry = byThread.get(m.thread);
      if (!entry) byThread.set(m.thread, (entry = { participants: new Set(), messages: [] }));
      entry.participants.add(m.from);
      if (m.to !== "all") entry.participants.add(m.to);
      entry.messages.push(m);
    }
    const unread = unreadFor(name);
    return [...byThread.entries()]
      .map(([thread, { participants, messages }]) => {
        const last = messages[messages.length - 1]!;
        return {
          thread,
          participants: [...participants].sort(),
          messages: messages.length,
          unread: unread.filter((m) => m.thread === thread).length,
          last: { id: last.id, from: last.from, ts: last.ts, preview: last.body.slice(0, 120) },
        };
      })
      .sort((a, b) => b.last.id - a.last.id)
      .slice(0, 50);
  }

  function notify(to: string): void {
    const targets = to === "all" ? [...waiters.keys()] : [to];
    for (const name of targets) {
      const set = waiters.get(name);
      if (!set) continue;
      waiters.delete(name);
      for (const wake of set) wake();
    }
  }

  function waitForMail(name: string, seconds: number, req: IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      let set = waiters.get(name);
      if (!set) waiters.set(name, (set = new Set()));
      const done = (): void => {
        clearTimeout(timer);
        set!.delete(done);
        req.off("close", done);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      set.add(done);
      req.once("close", done);
    });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");

      if (url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION });
      if (!authorized(req)) return send(res, 401, { error: "bad or missing token" });

      const name = String(req.headers["x-agent-name"] ?? "").toLowerCase();
      if (!NAME_PATTERN.test(name)) return send(res, 400, { error: "missing or invalid X-Agent-Name header" });
      if (rateLimited(name)) return send(res, 429, { error: "rate limit exceeded, slow down" });

      state.peers[name] = new Date().toISOString();
      persist();

      if (req.method === "GET" && url.pathname === "/peers") {
        const peers = Object.entries(state.peers)
          .map(([peer, lastSeen]) => ({ name: peer, lastSeen }))
          .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
        return send(res, 200, { peers });
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const raw = await readBody(req, maxBodyBytes + 1024);
        const input = JSON.parse(raw) as { to?: unknown; body?: unknown; thread?: unknown };
        const to = typeof input.to === "string" ? input.to.toLowerCase() : "";
        const body = typeof input.body === "string" ? input.body : "";
        const thread = input.thread === undefined ? DEFAULT_THREAD : String(input.thread).toLowerCase();
        if (to !== "all" && !NAME_PATTERN.test(to)) return send(res, 400, { error: "invalid recipient" });
        if (!THREAD_PATTERN.test(thread)) {
          return send(res, 400, { error: "invalid thread: use lowercase letters, digits, - or _ (max 64 chars)" });
        }
        if (to === name) return send(res, 400, { error: "cannot message yourself" });
        if (!body.trim()) return send(res, 400, { error: "message body is empty" });
        if (Buffer.byteLength(body) > maxBodyBytes) return send(res, 413, { error: `message over ${maxBodyBytes} bytes` });

        const message: Message = { id: state.nextId++, from: name, to, thread, body, ts: new Date().toISOString() };
        state.messages.push(message);
        if (state.messages.length > maxMessages) state.messages.splice(0, state.messages.length - maxMessages);
        persist();
        notify(to);
        return send(res, 201, { message, recipientKnown: to === "all" || to in state.peers });
      }

      if (req.method === "GET" && url.pathname === "/threads") {
        return send(res, 200, { threads: threadsFor(name) });
      }

      if (req.method === "GET" && url.pathname === "/inbox") {
        const peek = url.searchParams.get("peek") === "1";
        const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), MAX_WAIT_SECONDS);
        const requested = url.searchParams.getAll("thread").map((t) => t.toLowerCase());
        if (requested.some((t) => !THREAD_PATTERN.test(t))) return send(res, 400, { error: "invalid thread" });
        const threads = requested.length > 0 ? new Set(requested) : undefined;

        let messages = unreadFor(name, threads);
        if (!peek) {
          // Mail in other threads also wakes us, so keep waiting until something
          // in a requested thread arrives, the deadline passes, or the client leaves.
          const deadline = Date.now() + wait * 1000;
          let clientGone = false;
          req.once("close", () => (clientGone = true));
          while (messages.length === 0 && Date.now() < deadline && !clientGone) {
            await waitForMail(name, (deadline - Date.now()) / 1000, req);
            messages = unreadFor(name, threads);
          }
          if (messages.length > 0) markRead(name, messages);
        }
        return send(res, 200, { messages });
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof SyntaxError ? 400 : err instanceof BodyTooLarge ? 413 : 500;
      if (status === 500) console.error("relay error:", err);
      return send(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
    }
  });
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function loadState(dataFile: string | undefined): State {
  const empty: State = { nextId: 1, messages: [], cursors: {}, peers: {} };
  if (!dataFile) return empty;
  try {
    const state: State = { ...empty, ...(JSON.parse(readFileSync(dataFile, "utf8")) as Partial<State>) };
    // Messages saved before threads existed belong to the default thread.
    for (const m of state.messages) m.thread ??= DEFAULT_THREAD;
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw new Error(`Could not load relay data from ${dataFile}: ${(err as Error).message}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = process.env.RELAY_TOKEN;
  if (!token || token.length < 16) {
    console.error("Set RELAY_TOKEN to a shared secret of at least 16 chars (e.g. `openssl rand -hex 24`).");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  const dataFile = process.env.RELAY_DATA_FILE ?? "relay-data.json";
  createRelay({ token, dataFile }).listen(port, () => {
    console.log(`claude-relay listening on :${port} (data: ${dataFile})`);
  });
}
