import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClientConfig {
  url: string;
  token: string;
  name: string;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const THREAD_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_THREAD = "main";

// Env vars win; ~/.claude-relay.json is the fallback so the MCP server and
// the hook (which runs without the MCP env) share one source of truth.
export function loadClientConfig(): ClientConfig {
  let file: Partial<ClientConfig> = {};
  const path = process.env.CLAUDE_RELAY_CONFIG ?? join(homedir(), ".claude-relay.json");
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Partial<ClientConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
    }
  }

  const url = process.env.RELAY_URL ?? file.url;
  const token = process.env.RELAY_TOKEN ?? file.token;
  const name = (process.env.RELAY_NAME ?? file.name)?.toLowerCase();

  const missing = [!url && "url (RELAY_URL)", !token && "token (RELAY_TOKEN)", !name && "name (RELAY_NAME)"]
    .filter(Boolean)
    .join(", ");
  if (missing) throw new Error(`claude-relay is missing config: ${missing}`);
  if (!NAME_PATTERN.test(name!)) {
    throw new Error(`Invalid name "${name}": use lowercase letters, digits, - or _ (max 32 chars)`);
  }

  return { url: url!.replace(/\/+$/, ""), token: token!, name: name! };
}
