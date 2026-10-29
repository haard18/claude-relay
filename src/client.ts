import type { ClientConfig } from "./config.js";
import type { Message, ThreadSummary } from "./relay.js";

export interface Peer {
  name: string;
  lastSeen: string;
}

export interface InboxOptions {
  waitSeconds?: number;
  peek?: boolean;
  threads?: string[]; // only these threads; omit or empty for all
}

export class RelayClient {
  constructor(private readonly config: ClientConfig) {}

  get name(): string {
    return this.config.name;
  }

  async send(to: string, body: string, thread?: string): Promise<{ message: Message; recipientKnown: boolean }> {
    const res = await this.request("/messages", { method: "POST", body: JSON.stringify({ to, body, thread }) });
    const data = (await res.json()) as { message?: Message; recipientKnown?: boolean };
    if (!data.message || typeof data.message.id !== "number") throw new Error("relay returned a malformed send response");
    return { message: data.message, recipientKnown: data.recipientKnown === true };
  }

  async inbox(opts: InboxOptions = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts.waitSeconds) params.set("wait", String(opts.waitSeconds));
    if (opts.peek) params.set("peek", "1");
    for (const thread of opts.threads ?? []) params.append("thread", thread);
    const res = await this.request(`/inbox?${params}`, {}, ((opts.waitSeconds ?? 0) + 15) * 1000);
    const data = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(data.messages)) throw new Error("relay returned a malformed inbox response");
    return data.messages.filter(isMessage);
  }

  async threads(): Promise<ThreadSummary[]> {
    const res = await this.request("/threads");
    const data = (await res.json()) as { threads?: unknown };
    if (!Array.isArray(data.threads)) throw new Error("relay returned a malformed threads response");
    return data.threads as ThreadSummary[];
  }

  async peers(): Promise<Peer[]> {
    const res = await this.request("/peers");
    const data = (await res.json()) as { peers?: unknown };
    if (!Array.isArray(data.peers)) throw new Error("relay returned a malformed peers response");
    return data.peers as Peer[];
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const res = await fetch(`${this.config.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "x-agent-name": this.config.name,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`relay ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }
}

function isMessage(value: unknown): value is Message {
  const m = value as Message;
  return (
    typeof m === "object" && m !== null &&
    typeof m.id === "number" && typeof m.from === "string" && typeof m.to === "string" &&
    typeof m.thread === "string" && typeof m.body === "string" && typeof m.ts === "string"
  );
}

export function formatMessages(messages: Message[]): string {
  return messages
    .map((m) => `[#${m.id} ${m.ts}] thread "${m.thread}", from ${m.from}${m.to === "all" ? " (to all)" : ""}:\n${m.body}`)
    .join("\n\n---\n\n");
}
