import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createRelay } from "./relay.js";
import { RelayClient } from "./client.js";

const TOKEN = "test-token-0123456789";

async function withRelay(fn: (url: string) => Promise<void>, rateLimitPerMinute?: number): Promise<void> {
  const server = createRelay({ token: TOKEN, rateLimitPerMinute });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("direct messages are delivered once and only to the recipient", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });
    const carol = new RelayClient({ url, token: TOKEN, name: "carol" });

    await alice.send("bob", "hi bob");
    assert.equal((await bob.inbox({ peek: true })).length, 1, "peek sees it");
    const got = await bob.inbox();
    assert.deepEqual(got.map((m) => [m.from, m.body]), [["alice", "hi bob"]]);
    assert.equal((await bob.inbox()).length, 0, "consumed after read");
    assert.equal((await carol.inbox()).length, 0, "not leaked to others");
  }));

test("broadcast reaches everyone except the sender", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });
    await alice.send("all", "standup in 5");
    assert.equal((await bob.inbox()).length, 1);
    assert.equal((await alice.inbox()).length, 0);
  }));

test("long-poll wakes up when a message arrives", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });
    const started = Date.now();
    const pending = bob.inbox({ waitSeconds: 10 });
    setTimeout(() => void alice.send("bob", "ping"), 200);
    const got = await pending;
    assert.equal(got[0]?.body, "ping");
    assert.ok(Date.now() - started < 5000);
  }));

test("rejects bad tokens and rate-limits", () =>
  withRelay(async (url) => {
    const intruder = new RelayClient({ url, token: "wrong-token-xxxxxxxx", name: "eve" });
    await assert.rejects(intruder.peers(), /relay 401/);

    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    await alice.peers();
    await alice.peers();
    await assert.rejects(alice.peers(), /relay 429/);
  }, 2));
