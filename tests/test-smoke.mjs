/**
 * Integration smoke test for pi-commandcode-provider.
 *
 * Tests that the extension:
 * 1. Loads without crashing in print mode
 * 2. Registers the provider and models
 * 3. Can complete a simple query (requires COMMANDCODE_API_KEY)
 *
 * Run with: node tests/test-smoke.mjs
 * Requires: pi on PATH, COMMANDCODE_API_KEY env var set (or test is skipped)
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const EXT_PATH = resolve(PROJECT_DIR, "index.ts");

const PRINT_MODE_TIMEOUT = 120_000; // 2 minutes for print mode
const RPC_START_TIMEOUT = 15_000;
const RPC_QUERY_TIMEOUT = 60_000;

const HAS_API_KEY = !!process.env.COMMANDCODE_API_KEY;

let passed = 0;
let failed = 0;
let skipped = 0;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function kill(child) {
  try {
    child.kill();
  } catch {
    // ignore
  }
}

// -------------------------------------------------------------------------
// Test 1: Print mode — extension loads and agent runs
// -------------------------------------------------------------------------

async function runPrintMode() {
  if (!HAS_API_KEY) {
    console.log("[smoke] SKIP — COMMANDCODE_API_KEY not set, skipping print mode test\n");
    skipped++;
    return;
  }

  console.log(`[smoke] Running pi in print mode with extension: ${EXT_PATH}`);
  console.log(`[smoke]   pi -e ${EXT_PATH} -p "say hi" --provider commandcode --model claude-sonnet-4-6\n`);

  const child = spawn("pi", [
    "-e", EXT_PATH,
    "-p", "say hi in one word",
    "--provider", "commandcode",
    "--model", "claude-sonnet-4-6",
    "--thinking-level", "minimal",
  ], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(child);
      console.log("[smoke] TIMEOUT — pi print mode took too long");
      resolve(false);
    }, PRINT_MODE_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log("[smoke] PASS — extension loaded and agent ran without crash");
        console.log(`[smoke] stdout (last 300 chars): ${stdout.slice(-300).trim()}`);
      } else {
        console.log(`[smoke] FAIL — exit code ${code}`);
        console.log(`[smoke] stderr (last 500 chars): ${stderr.slice(-500).trim()}`);
      }
      resolve(code === 0);
    });
  });

  const ok = await done;
  if (ok) passed++;
  else failed++;
}

// -------------------------------------------------------------------------
// Test 2: Print mode — provider discovery (list models)
// -------------------------------------------------------------------------

async function runListModels() {
  if (!HAS_API_KEY) {
    console.log("[smoke] SKIP — no API key, skipping model list test\n");
    skipped++;
    return;
  }

  console.log(`[smoke] Checking that models are discoverable via pi --list-models\n`);

  const child = spawn("pi", [
    "-e", EXT_PATH,
    "--list-models",
  ], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";

  child.stdout.on("data", (d) => { stdout += d.toString(); });

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(child);
      console.log("[smoke] TIMEOUT — model listing took too long");
      resolve(false);
    }, 15_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.includes("commandcode")) {
        console.log("[smoke] PASS — commandcode provider models are listed");
      } else {
        console.log("[smoke] FAIL — commandcode models not found or error listing");
        console.log(`[smoke] stdout (last 500 chars): ${stdout.slice(-500).trim()}`);
      }
      resolve(code === 0 && stdout.includes("commandcode"));
    });
  });

  const ok = await done;
  if (ok) passed++;
  else failed++;
}

// -------------------------------------------------------------------------
// Test 3: RPC mode — extension loads, session starts
// -------------------------------------------------------------------------

async function runRpcStartup() {
  if (!HAS_API_KEY) {
    console.log("[smoke] SKIP — no API key, skipping RPC startup test\n");
    skipped++;
    return;
  }

  console.log(`[smoke] Testing RPC mode startup with extension\n`);
  console.log(`[smoke]   pi --mode rpc -e ${EXT_PATH}\n`);

  const child = spawn("pi", [
    "--mode", "rpc",
    "-e", EXT_PATH,
  ], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let sawSessionStart = false;
  let sawError = false;
  const events = [];

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        events.push(msg);
        if (msg.type === "session_start") {
          sawSessionStart = true;
          console.log("[smoke] RPC received session_start event");
        }
        if (msg.type === "error" || msg.type === "fatal") {
          sawError = true;
          console.error(`[smoke] RPC error: ${JSON.stringify(msg).slice(0, 300)}`);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });

  const result = new Promise((resolve) => {
    const timer = setTimeout(async () => {
      if (sawSessionStart) {
        console.log("[smoke] PASS — extension loaded, session started in RPC mode");
        resolve(true);
      } else {
        console.log("[smoke] FAIL — session_start not received within 5s");
        resolve(false);
      }
      // Send quit
      try { child.stdin.write(JSON.stringify({ type: "quit" }) + "\n"); } catch {}
      kill(child);
    }, RPC_START_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!sawSessionStart && !sawError) {
        console.log(`[smoke] FAIL — pi exited with code ${code} before session_start`);
        resolve(false);
      }
    });
  });

  const ok = await result;
  if (ok) passed++;
  else failed++;
}

// -------------------------------------------------------------------------
// Test 4: RPC mode — send query and receive assistant message
// -------------------------------------------------------------------------

async function runRpcQuery() {
  if (!HAS_API_KEY) {
    console.log("[smoke] SKIP — no API key, skipping RPC query test\n");
    skipped++;
    return;
  }

  console.log(`[smoke] Testing RPC query flow\n`);
  console.log(`[smoke]   pi --mode rpc -e ${EXT_PATH} → query "say hi" → expect response\n`);

  const child = spawn("pi", [
    "--mode", "rpc",
    "-e", EXT_PATH,
    "--provider", "commandcode",
    "--model", "claude-sonnet-4-6",
    "--thinking-level", "minimal",
  ], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let sawSessionStart = false;
  let sawAssistantMessage = false;
  let querySent = false;

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === "session_start") {
          sawSessionStart = true;
          // Now send a query
          if (!querySent) {
            querySent = true;
            const query = {
              type: "query",
              query: "say hi in one word",
              sessionId: msg.sessionId,
            };
            child.stdin.write(JSON.stringify(query) + "\n");
            console.log("[smoke] Sent RPC query");
          }
        }
        if (msg.type === "assistant_message") {
          sawAssistantMessage = true;
          console.log("[smoke] PASS — received assistant_message in RPC mode");
        }
      } catch {
        // ignore
      }
    }
  });

  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (sawAssistantMessage) {
        console.log("[smoke] PASS — full RPC query/response cycle works");
        resolve(true);
      } else {
        console.log("[smoke] WARN — no assistant_message received (may still be streaming)");
        resolve(false);
      }
      try { child.stdin.write(JSON.stringify({ type: "quit" }) + "\n"); } catch {}
      kill(child);
    }, RPC_QUERY_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!sawAssistantMessage) {
        console.log(`[smoke] FAIL — pi exited before assistant_message`);
        resolve(false);
      }
    });
  });

  const ok = await result;
  if (ok) passed++;
  else failed++;
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

console.log("=".repeat(60));
console.log("  pi-commandcode-provider Integration Smoke Test");
console.log("=".repeat(60));
console.log(`  API key: ${HAS_API_KEY ? "✓ found" : "✗ not set (tests will be skipped)"}`);
console.log(`  Extension: ${EXT_PATH}`);
console.log("=".repeat(60));
console.log("");

await runPrintMode();
await runListModels();
await runRpcStartup();
await runRpcQuery();

console.log("");
console.log("=".repeat(60));
console.log(`  SUITE RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
