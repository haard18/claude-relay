#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: if teammates have sent messages, tell
// Claude so it can call check_messages. Peeks only (does not mark read) and
// never blocks the prompt — any failure just prints nothing.
//
// The hook runs outside the MCP server, so it cannot see a session's
// `subscribe` choice. It reports unread counts per thread and leaves it to
// Claude, which knows its subscription, to read only the threads it follows.
// Set RELAY_THREADS in the hook's environment to report only those threads.
import { loadClientConfig } from "./config.js";
import { RelayClient } from "./client.js";

try {
  const client = new RelayClient(loadClientConfig());
  const threads = (process.env.RELAY_THREADS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const unread = await client.inbox({ peek: true, threads });
  if (unread.length > 0) {
    const byThread = new Map<string, { count: number; senders: Set<string> }>();
    for (const m of unread) {
      let entry = byThread.get(m.thread);
      if (!entry) byThread.set(m.thread, (entry = { count: 0, senders: new Set() }));
      entry.count += 1;
      entry.senders.add(m.from);
    }
    const summary = [...byThread.entries()]
      .map(([thread, { count, senders }]) => `"${thread}" (${count} from ${[...senders].join(", ")})`)
      .join(", ");
    console.log(
      `[claude-relay] Unread messages in thread(s): ${summary}. If this session is subscribed to any of these ` +
        `threads (or to all threads), call check_messages and mention them to the user; ignore threads it is not subscribed to.`,
    );
  }
} catch {
  // Relay unreachable or not configured: stay silent rather than disrupt the user.
}
