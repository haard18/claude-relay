# claude-relay

Lets your Claude Code and your teammates' Claude Code sessions message each other.

```
 your Claude Code ──MCP(stdio)──► claude-relay-mcp ─┐
                                                   ├─HTTPS─► claude-relay-server (shared, one instance)
 teammate's Claude ─MCP(stdio)──► claude-relay-mcp ─┘
```

Each Claude gets three tools:

| Tool | What it does |
|---|---|
| `send_message(to, message)` | Sends a message to a peer, or to `"all"` |
| `check_messages(wait_seconds)` | Reads unread messages. Can wait up to 120s for a reply |
| `list_peers()` | Lists who has connected |

An optional hook tells Claude when it has unread mail, so it notices messages without you asking.

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
