/**
 * Command Code provider for pi.
 * Connects pi to Command Code's API (https://api.commandcode.ai/alpha/generate).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  calculateCost,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const API_BASE = "https://api.commandcode.ai";

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

const MODELS = [
  // Premium (Anthropic)
  { id: "claude-opus-4-7", name: "Claude Opus 4.7 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 16_384 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 8_192 },
  // Premium (OpenAI)
  { id: "gpt-5.5", name: "GPT-5.5 (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.4", name: "GPT-5.4 (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (CC)", reasoning: false, contextWindow: 256_000, maxTokens: 128_000 },
  // Open-source
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6 (CC)", reasoning: true, contextWindow: 262_144, maxTokens: 131_072 },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5 (CC)", reasoning: true, contextWindow: 262_144, maxTokens: 131_072 },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 131_072 },
  { id: "zai-org/GLM-5", name: "GLM-5 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 131_072 },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7 (CC)", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5 (CC)", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072 },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toJsonSchema(schema: any): any {
  if (!schema) return {};
  const s = schema as Record<string, any>;
  const kind = s.kind ?? s.type;
  if (s.enum) return { type: typeof s.enum[0], enum: s.enum };
  switch (kind) {
    case "string": case "String": return { type: "string" };
    case "number": case "Number": return { type: "number" };
    case "boolean": case "Boolean": return { type: "boolean" };
    case "object": case "Object": {
      const props: Record<string, any> = {};
      const inferredRequired: string[] = [];
      if (s.properties) {
        for (const [k, v] of Object.entries(s.properties)) {
          props[k] = toJsonSchema(v);
          if (!(v as any).optional && !s.optional?.includes?.(k)) inferredRequired.push(k);
        }
      }
      const required = Array.isArray(s.required) ? s.required : inferredRequired;
      const out: any = { type: "object" };
      if (Object.keys(props).length) out.properties = props;
      if (required.length) out.required = required;
      return out;
    }
    case "array": case "Array": return { type: "array", items: toJsonSchema(s.items ?? s.element) };
    case "union": case "Union": {
      const variants = s.variants ?? s.anyOf ?? [];
      for (const v of variants) { const sch = toJsonSchema(v); if (sch && Object.keys(sch).length) return sch; }
      return {};
    }
    case "optional": case "Optional": return toJsonSchema(s.wrapped ?? s.inner);
    default: return {};
  }
}

function toolsToJson(tools: any[]): any[] {
  if (!tools) return [];
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    input_schema: t.parameters ? toJsonSchema(t.parameters) : {},
  }));
}

function messagesToCC(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : m.content });
    } else if (m.role === "assistant") {
      const parts: any[] = [];
      for (const c of m.content) {
        if (c.type === "text") parts.push({ type: "text", text: c.text });
        else if (c.type === "thinking") parts.push({ type: "reasoning", text: c.thinking });
        else if (c.type === "toolCall") parts.push({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.arguments });
      }
      out.push({ role: "assistant", content: parts });
    } else if (m.role === "toolResult") {
      const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n");
      out.push({ role: "tool", content: [{ type: "tool-result", toolCallId: m.toolCallId, toolName: m.toolName, output: m.isError ? { type: "error-text", value: text } : { type: "text", value: text } }] });
    }
  }
  return out;
}

function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`;
}

function uuid(): string {
  return crypto.randomUUID();
}

function parseStreamEventLine(line: string): any | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function mapFinishReason(reason: unknown): "stop" | "length" | "toolUse" {
  if (reason === "tool-calls") return "toolUse";
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") return "length";
  return "stop";
}

// ---------------------------------------------------------------------------
// Stream implementation
// ---------------------------------------------------------------------------

function streamCommandCode(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const apiKey = options?.apiKey ?? process.env.COMMANDCODE_API_KEY;
    if (!apiKey) {
      const msg: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error", errorMessage: "No Command Code API key. Set COMMANDCODE_API_KEY env var.",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: msg });
      stream.end();
      return;
    }

    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };

    const controller = new AbortController();

    try {
      stream.push({ type: "start", partial: output });

      const response = await fetch(`${API_BASE}/alpha/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-command-code-version": "0.24.1",
          "x-cli-environment": "production",
          "x-project-slug": "pi-cc",
          "x-taste-learning": "false",
          "x-co-flag": "false",
          "x-session-id": uuid(),
        },
        body: JSON.stringify({
          config: {
            workingDir: process.cwd(),
            date: new Date().toISOString().split("T")[0],
            environment: getEnvironmentInfo(),
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: [],
          },
          memory: "", taste: "", skills: null,
          permissionMode: "standard" as const,
          params: {
            model: model.id,
            messages: messagesToCC(context.messages),
            tools: toolsToJson(context.tools),
            system: context.systemPrompt ?? "",
            max_tokens: Math.min(options?.maxTokens ?? model.maxTokens, 200_000),
            stream: true,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`Command Code API error ${response.status}: ${errBody.slice(0, 500)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let currentTextIdx = -1;
      let textBlock: any = null;
      let reasoningActive = false;
      let thinkingBlock: string[] = [];
      let finished = false;

      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseStreamEventLine(line);
          if (!event) continue;

          switch (event.type) {
            case "text-delta": {
              if (!textBlock) {
                textBlock = { type: "text", text: "" };
                output.content.push(textBlock);
                currentTextIdx = output.content.length - 1;
                stream.push({ type: "text_start", contentIndex: currentTextIdx, partial: output });
              }
              textBlock.text += event.text ?? "";
              stream.push({ type: "text_delta", contentIndex: currentTextIdx, delta: event.text ?? "", partial: output });
              break;
            }
            case "reasoning-delta": {
              if (!reasoningActive) reasoningActive = true;
              thinkingBlock.push(event.text ?? "");
              break;
            }
            case "reasoning-end": {
              if (thinkingBlock.length > 0) {
                const thinkingText = thinkingBlock.join("");
                thinkingBlock = [];
                output.content.push({ type: "thinking", thinking: thinkingText });
                const idx = output.content.length - 1;
                stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
                stream.push({ type: "thinking_delta", contentIndex: idx, delta: thinkingText, partial: output });
                stream.push({ type: "thinking_end", contentIndex: idx, content: thinkingText, partial: output });
              }
              reasoningActive = false;
              break;
            }
            case "tool-call": {
              if (textBlock) {
                stream.push({ type: "text_end", contentIndex: currentTextIdx, content: textBlock.text, partial: output });
                textBlock = null;
                currentTextIdx = -1;
              }
              output.content.push({ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.input ?? event.args ?? {} });
              const idx = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
              stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.input ?? event.args ?? {} }, partial: output });
              break;
            }
            case "finish": {
              const usage = event.totalUsage;
              if (usage) {
                output.usage.input = usage.inputTokens ?? 0;
                output.usage.output = usage.outputTokens ?? 0;
                output.usage.cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
                output.usage.cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
                output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                calculateCost(model, output.usage);
              }
              output.stopReason = mapFinishReason(event.finishReason);
              finished = true;
              break;
            }
            case "error": {
              const msg = event.error?.message ?? event.error ?? "Stream error";
              output.stopReason = "error";
              output.errorMessage = typeof msg === "string" ? msg : String(msg);
              throw new Error(output.errorMessage);
            }
          }
          if (finished) break readLoop;
        }
      }

      if (textBlock) {
        stream.push({ type: "text_end", contentIndex: currentTextIdx, content: textBlock.text, partial: output });
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error: any) {
      output.stopReason = "error";
      output.errorMessage = error?.message ?? String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "!python3 -c 'import json,pathlib; key=\"\"; paths=[pathlib.Path.home()/\".commandcode/auth.json\", pathlib.Path.home()/\".pi/agent/auth.json\"];\nfor p in paths:\n    try:\n        data=json.loads(p.read_text()); key=data.get(\"apiKey\") or data.get(\"commandcode\") or key\n        if key: break\n    except Exception: pass\nprint(key)'",
    authHeader: true,
    api: "commandcode-custom" as any,
    streamSimple: streamCommandCode,
    headers: {
      "x-command-code-version": "0.24.1",
      "x-cli-environment": "production",
    },
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
}
