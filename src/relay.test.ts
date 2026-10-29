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

test("a thread subscription only consumes that thread", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });

    await alice.send("bob", "untitled");
    await alice.send("bob", "auth question", "auth");
    await alice.send("bob", "deploy question", "deploy");

    const auth = await bob.inbox({ threads: ["auth"] });
    assert.deepEqual(auth.map((m) => [m.thread, m.body]), [["auth", "auth question"]]);
    assert.equal((await bob.inbox({ threads: ["auth"] })).length, 0, "auth consumed");

    const rest = await bob.inbox();
    assert.deepEqual(rest.map((m) => m.thread), ["main", "deploy"], "other threads were left unread");
  }));

test("long-poll on a thread ignores mail in other threads", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });
    const pending = bob.inbox({ waitSeconds: 10, threads: ["auth"] });
    setTimeout(() => void alice.send("bob", "noise", "deploy"), 100);
    setTimeout(() => void alice.send("bob", "signal", "auth"), 400);
    const got = await pending;
    assert.deepEqual(got.map((m) => m.body), ["signal"]);
    assert.deepEqual((await bob.inbox()).map((m) => m.body), ["noise"]);
  }));

test("threads lists summaries with unread counts", () =>
  withRelay(async (url) => {
    const alice = new RelayClient({ url, token: TOKEN, name: "alice" });
    const bob = new RelayClient({ url, token: TOKEN, name: "bob" });
    await alice.send("bob", "one", "auth");
    await bob.send("alice", "two", "auth");
    await alice.send("bob", "three", "deploy");
    const threads = await bob.threads();
    assert.deepEqual(
      threads.map((t) => [t.thread, t.messages, t.unread, t.participants.join("+")]),
      [["deploy", 1, 1, "alice+bob"], ["auth", 2, 1, "alice+bob"]],
    );
    await assert.rejects(alice.send("bob", "x", "Bad Thread!"), /relay 400/);
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
