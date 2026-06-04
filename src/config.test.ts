import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `copilot-agent-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "agents"), { recursive: true });
    mkdirSync(join(tempDir, "sessions"), { recursive: true });
    mkdirSync(join(tempDir, "skills"), { recursive: true });
    mkdirSync(join(tempDir, "logs"), { recursive: true });
  });

  const savedEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars (dotenv mutates process.env)
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string, env = "TELEGRAM_BOT_TOKEN=fake\n") {
    writeFileSync(join(tempDir, "config.yaml"), yaml);
    writeFileSync(join(tempDir, ".env"), env);
  }

  it("loads valid config", () => {
    writeConfig(`
active:
  provider: openai
  model: gpt-4o
providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
telegram:
  allowed_user_ids: [123]
agents:
  dir: ./agents
  default: assistant
session:
  history_dir: ./sessions
  max_messages: 200
permissions:
  mode: approve-all
  timeout_seconds: 300
`, "TELEGRAM_BOT_TOKEN=fake\nOPENAI_API_KEY=sk-test\n");

    const config = loadConfig(tempDir);
    expect(config.active.provider).toBe("openai");
    expect(config.active.model).toBe("gpt-4o");
    expect(config.telegram.allowed_user_ids).toEqual([123]);
    expect(config.permissions.mode).toBe("approve-all");
  });

  it("throws on missing config.yaml", () => {
    expect(() => loadConfig(tempDir)).toThrow("Config file not found");
  });

  it("throws on invalid config", () => {
    writeConfig("not: valid: yaml: [");
    expect(() => loadConfig(tempDir)).toThrow();
  });

  it("throws on empty allowed_user_ids", () => {
    writeConfig(`
active:
  provider: openai
  model: gpt-4o
providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
telegram:
  allowed_user_ids: []
agents:
  dir: ./agents
  default: assistant
session:
  history_dir: ./sessions
permissions:
  mode: approve-all
`, "TELEGRAM_BOT_TOKEN=fake\nOPENAI_API_KEY=sk-test\n");

    expect(() => loadConfig(tempDir)).toThrow("allowlist");
  });

  it("throws on missing env var for active provider", () => {
    writeConfig(`
active:
  provider: openai
  model: gpt-4o
providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
telegram:
  allowed_user_ids: [123]
agents:
  dir: ./agents
  default: assistant
session:
  history_dir: ./sessions
permissions:
  mode: approve-all
`, "TELEGRAM_BOT_TOKEN=fake\n");

    expect(() => loadConfig(tempDir)).toThrow("OPENAI_API_KEY");
  });
});
