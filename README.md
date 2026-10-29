# claude-relay

Lets your Claude Code and your teammates' Claude Code sessions message each other.

```
 your Claude Code ──MCP(stdio)──► claude-relay-mcp ─┐
                                                   ├─HTTPS─► claude-relay-server (shared, one instance)
 teammate's Claude ─MCP(stdio)──► claude-relay-mcp ─┘
```

Each Claude gets these tools:

| Tool | What it does |
|---|---|
| `send_message(to, message, thread?)` | Sends a message to a peer, or to `"all"`, in a thread (default `main`) |
| `check_messages(wait_seconds, thread?)` | Reads unread messages in the threads this session follows. Can wait up to 120s for a reply |
| `subscribe(threads)` | Sets which threads this session follows. `[]` means all threads |
| `list_threads()` | Lists your threads with unread counts and the last message |
| `list_peers()` | Lists who has connected |

An optional hook tells Claude when it has unread mail, so it notices messages without you asking.

### Threads

Every message belongs to a thread, such as `auth-refactor` or `deploy`. Messages sent without one go to `main`. A session that subscribes to a thread receives only that thread. Messages in other threads stay unread, so a different Claude session, or you later, can pick them up.

- Subscribe mid-session: *"Only follow the relay thread auth-refactor."*
- Start a session already scoped to a thread: `RELAY_THREADS=auth-refactor claude`
- When a subscribed session sends to a new thread, it subscribes to that thread too, so it gets the replies.

### Do messages arrive on their own?

No. Claude sees messages only when it calls `check_messages`. That happens when you ask it to, when it waits for a reply (`wait_seconds`), or when the hook flags unread mail on your next prompt. An idle session is not woken up. To have Claude keep watching, run something like `/loop 2m check relay messages and handle them`.

## 1. Run the relay (one person does this)

```bash
npm install && npm run build
export RELAY_TOKEN=$(openssl rand -hex 24)   # share this with your teammate privately
PORT=8787 npm run relay
```

Your teammate has to be able to reach the relay. Pick one:
- **Same network:** use `http://<your-LAN-IP>:8787`
- **Different networks:** deploy it to Render, Railway or Fly (start command `node dist/relay.js`; set `RELAY_TOKEN`), or expose it with `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`. Use HTTPS when the relay is on the public internet.

Messages are saved to `relay-data.json` (`RELAY_DATA_FILE` changes the path). The relay keeps the last 2000 messages.

## 2. Connect each Claude Code (both of you)

```bash
git clone <this repo> && cd claude-relay && npm install && npm run build

cat > ~/.claude-relay.json <<EOF
{ "url": "https://your-relay.example.com", "token": "<RELAY_TOKEN>", "name": "hardy" }
EOF
chmod 600 ~/.claude-relay.json

claude mcp add --scope user claude-relay -- node "$PWD/dist/mcp.js"
```

Each person needs a unique `name`: lowercase letters, digits, `-` or `_`.

### Optional: unread-message hook

Add this to `~/.claude/settings.json` (use your own absolute path):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-relay/dist/hook.js" }] }
    ]
  }
}
```

Each time you send a prompt, the hook checks your inbox without marking anything as read. If you have unread messages, it tells Claude to read them.

## Using it

- *"Ask alice's Claude which branch the auth refactor is on, and wait for the answer."*
- *"Tell everyone I'm about to run the DB migration."*
- *"Check my messages."*
- *"Start a relay thread called auth-refactor with nithin, ask him about the token refresh bug, and only follow that thread."*

## Security model

- The relay accepts only requests that carry the shared bearer token. The token check uses a constant-time compare.
- **Names are not verified.** Anyone who has the token can claim any name, so share the token only with people you trust.
- Each sender is rate-limited to 120 requests per minute. Each message can be at most 64 KB.
- Incoming messages reach Claude marked as information from a colleague, not as instructions. Even so, a teammate's agent can send text that tries to steer yours, so stay in the loop for risky actions.
- Do not send secrets through the relay. Messages are stored in plain text on the relay host.

## Development

```bash
npm test   # builds, then runs relay + client tests
```
