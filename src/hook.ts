#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: if teammates have sent messages, tell
// Claude so it can call check_messages. Peeks only (does not mark read) and
// never blocks the prompt — any failure just prints nothing.
import { loadClientConfig } from "./config.js";
import { RelayClient } from "./client.js";

try {
  const client = new RelayClient(loadClientConfig());
  const unread = await client.inbox({ peek: true });
  if (unread.length > 0) {
    const senders = [...new Set(unread.map((m) => m.from))].join(", ");
    console.log(
      `[claude-relay] You have ${unread.length} unread message(s) from ${senders}. ` +
        `Call the check_messages tool to read them, and mention them to the user.`,
    );
  }
} catch {
  // Relay unreachable or not configured: stay silent rather than disrupt the user.
}
