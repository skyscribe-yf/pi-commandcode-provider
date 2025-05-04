/**
 * Unit tests for pi-commandcode-provider pure functions.
 *
 * These tests DON'T require pi's runtime or any network access.
 * They verify message/tool/schema conversion logic in isolation.
 *
 * Run with: npx tsx tests/test-pure-functions.ts
 * Or:      node --import tsx tests/test-pure-functions.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Pure functions copied from index.ts (standalone, no pi imports needed)
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function textContent(m: { content: any[] }): string {
  return (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`;
}

/**
 * Minimal typebox → JSON Schema converter.
 * Handles Object, String, Number, Boolean, Array, Union, Optional, Enum.
 */
function toJsonSchema(schema: any): any {
  if (!schema) return {};
  const s = schema as Record<string, any>;
  const kind = s.kind ?? s.type;

  if (s.enum) {
    return { type: typeof s.enum[0], enum: s.enum };
  }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" };
    case "number":
    case "Number":
      return { type: "number" };
    case "boolean":
    case "Boolean":
      return { type: "boolean" };
    case "object":
    case "Object": {
      const props: Record<string, any> = {};
      const inferredRequired: string[] = [];
      if (s.properties) {
        for (const [k, v] of Object.entries(s.properties)) {
          props[k] = toJsonSchema(v);
          if (!(v as any).optional && !s.optional?.includes?.(k))
            inferredRequired.push(k);
        }
      }
      const required = Array.isArray(s.required) ? s.required : inferredRequired;
      const out: any = { type: "object" };
      if (Object.keys(props).length) out.properties = props;
      if (required.length) out.required = required;
      return out;
    }
    case "array":
    case "Array":
      return { type: "array", items: toJsonSchema(s.items ?? s.element) };
    case "union":
    case "Union": {
      const variants = s.variants ?? s.anyOf ?? [];
      for (const v of variants) {
        const schema = toJsonSchema(v);
        if (schema && Object.keys(schema).length) return schema;
      }
      return {};
    }
    case "optional":
    case "Optional":
      return toJsonSchema(s.wrapped ?? s.inner);
    default:
      return {};
  }
}

function toolsToJson(tools: any[]): any[] {
  if (!tools) return [];
  return tools.map((t) => {
    const schema = t.parameters ? toJsonSchema(t.parameters) : {};
    return {
      type: "function",
      name: t.name,
      description: t.description,
      input_schema: schema,
    };
  });
}

function messagesToCC(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : m.content,
      });
    } else if (m.role === "assistant") {
      const parts: any[] = [];
      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "thinking") {
          parts.push({ type: "reasoning", text: c.thinking });
        } else if (c.type === "toolCall") {
          parts.push({
            type: "tool-call",
            toolCallId: c.id,
            toolName: c.name,
            input: c.arguments,
          });
        }
      }
      out.push({ role: "assistant", content: parts });
    } else if (m.role === "toolResult") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: m.isError
              ? { type: "error-text", value: textContent(m) }
              : { type: "text", value: textContent(m) },
          },
        ],
      });
    }
  }
  return out;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("uuid()", () => {
  it("returns a valid UUID string", () => {
    const id = uuid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("returns unique values on each call", () => {
    const a = uuid();
    const b = uuid();
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------
// textContent
// ---------------------------------------------------------------

describe("textContent()", () => {
  it("extracts text from content array", () => {
    const msg = { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] };
    assert.equal(textContent(msg), "hello\nworld");
  });

  it("filters non-text content", () => {
    const msg = { content: [{ type: "text", text: "hello" }, { type: "image", data: "x" }] };
    assert.equal(textContent(msg), "hello");
  });

  it("returns empty string for empty content", () => {
    assert.equal(textContent({ content: [] }), "");
  });

  it("handles missing content gracefully", () => {
    assert.equal(textContent({ content: undefined as any }) ?? "", "");
  });
});

// ---------------------------------------------------------------
// getEnvironmentInfo
// ---------------------------------------------------------------

describe("getEnvironmentInfo()", () => {
  it("returns string with platform, arch, and node version", () => {
    const info = getEnvironmentInfo();
    assert.match(info, /^(darwin|linux|win32)-/);
    assert.ok(info.includes("Node.js"), `expected Node.js in: ${info}`);
  });
});

// ---------------------------------------------------------------
// toJsonSchema
// ---------------------------------------------------------------

describe("toJsonSchema — scalar types", () => {
  it("handles string (lowercase kind)", () => {
    assert.deepEqual(toJsonSchema({ kind: "string" }), { type: "string" });
  });
  it("handles String (capitalized)", () => {
    assert.deepEqual(toJsonSchema({ kind: "String" }), { type: "string" });
  });
  it("handles number", () => {
    assert.deepEqual(toJsonSchema({ kind: "number" }), { type: "number" });
  });
  it("handles Number", () => {
    assert.deepEqual(toJsonSchema({ kind: "Number" }), { type: "number" });
  });
  it("handles boolean", () => {
    assert.deepEqual(toJsonSchema({ kind: "boolean" }), { type: "boolean" });
  });
  it("handles Boolean", () => {
    assert.deepEqual(toJsonSchema({ kind: "Boolean" }), { type: "boolean" });
  });
});

describe("toJsonSchema — enum", () => {
  it("detects enum by property (string values)", () => {
    const schema = { kind: "string", enum: ["left", "right"] };
    assert.deepEqual(toJsonSchema(schema), { type: "string", enum: ["left", "right"] });
  });
  it("detects enum by property (number values)", () => {
    const schema = { kind: "number", enum: [1, 2, 3] };
    assert.deepEqual(toJsonSchema(schema), { type: "number", enum: [1, 2, 3] });
  });
});

describe("toJsonSchema — object", () => {
  it("converts simple object with string props", () => {
    const schema = {
      kind: "object",
      properties: {
        name: { kind: "string" },
        age: { kind: "number" },
      },
    };
    assert.deepEqual(toJsonSchema(schema), {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
  });

  it("marks optional properties correctly", () => {
    const schema = {
      kind: "object",
      properties: {
        name: { kind: "string" },
        nickname: { kind: "string", optional: true },
      },
    };
    const result = toJsonSchema(schema);
    assert.deepEqual(result.required, ["name"]);
    assert.deepEqual(result.properties?.nickname, { type: "string" });
  });

  it("handles optional via top-level optional array", () => {
    const schema = {
      kind: "Object",
      properties: {
        name: { kind: "string" },
        age: { kind: "number" },
      },
      optional: ["age"],
    };
    const result = toJsonSchema(schema);
    assert.deepEqual(result.required, ["name"]);
  });

  it("preserves TypeBox required arrays", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
    };
    const result = toJsonSchema(schema);
    assert.deepEqual(result.required, ["name"]);
  });

  it("handles empty object", () => {
    assert.deepEqual(toJsonSchema({ kind: "object" }), { type: "object" });
  });

  it("handles Object (capitalized)", () => {
    assert.deepEqual(toJsonSchema({ kind: "Object" }), { type: "object" });
  });
});

describe("toJsonSchema — array", () => {
  it("converts array with items", () => {
    const schema = { kind: "array", items: { kind: "string" } };
    assert.deepEqual(toJsonSchema(schema), { type: "array", items: { type: "string" } });
  });

  it("converts array with element (alternative prop name)", () => {
    const schema = { kind: "Array", element: { kind: "number" } };
    assert.deepEqual(toJsonSchema(schema), { type: "array", items: { type: "number" } });
  });
});

describe("toJsonSchema — union", () => {
  it("uses first non-empty variant", () => {
    const schema = { kind: "union", variants: [{}, { kind: "string" }] };
    assert.deepEqual(toJsonSchema(schema), { type: "string" });
  });

  it("uses anyOf as fallback property name", () => {
    const schema = { kind: "Union", anyOf: [{ kind: "number" }] };
    assert.deepEqual(toJsonSchema(schema), { type: "number" });
  });

  it("returns empty object for empty union", () => {
    assert.deepEqual(toJsonSchema({ kind: "union", variants: [] }), {});
  });
});

describe("toJsonSchema — optional", () => {
  it("unwraps optional via wrapped", () => {
    const schema = { kind: "optional", wrapped: { kind: "string" } };
    assert.deepEqual(toJsonSchema(schema), { type: "string" });
  });

  it("unwraps optional via inner", () => {
    const schema = { kind: "Optional", inner: { kind: "number" } };
    assert.deepEqual(toJsonSchema(schema), { type: "number" });
  });
});

describe("toJsonSchema — edge cases", () => {
  it("returns empty object for null", () => {
    assert.deepEqual(toJsonSchema(null), {});
  });

  it("returns empty object for undefined", () => {
    assert.deepEqual(toJsonSchema(undefined), {});
  });

  it("handles unknown kind gracefully", () => {
    assert.deepEqual(toJsonSchema({ kind: "foobar" }), {});
  });

  it("handles nested objects recursively", () => {
    const schema = {
      kind: "object",
      properties: {
        user: {
          kind: "object",
          properties: {
            name: { kind: "string" },
            address: {
              kind: "object",
              properties: { city: { kind: "string" } },
            },
          },
        },
      },
    };
    const result = toJsonSchema(schema);
    assert.equal(result.properties.user.type, "object");
    assert.equal(result.properties.user.properties.address.type, "object");
    assert.equal(
      result.properties.user.properties.address.properties.city.type,
      "string",
    );
  });

  it("handles type property as fallback for kind", () => {
    assert.deepEqual(toJsonSchema({ type: "string" }), { type: "string" });
  });
});

// ---------------------------------------------------------------
// toolsToJson
// ---------------------------------------------------------------

describe("toolsToJson()", () => {
  it("returns empty array for undefined", () => {
    assert.deepEqual(toolsToJson(undefined as any), []);
  });

  it("returns empty array for null", () => {
    assert.deepEqual(toolsToJson(null as any), []);
  });

  it("returns empty array for empty array", () => {
    assert.deepEqual(toolsToJson([]), []);
  });

  it("converts a tool with object parameters", () => {
    const tools = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        parameters: {
          kind: "object",
          properties: {
            city: { kind: "string" },
          },
        },
      },
    ];
    const result = toolsToJson(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "function");
    assert.equal(result[0].name, "get_weather");
    assert.equal(result[0].description, "Get the weather for a city");
    assert.deepEqual(result[0].input_schema, {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("handles tool without parameters", () => {
    const tools = [{ name: "ping", description: "Check connectivity" }];
    const result = toolsToJson(tools);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].input_schema, {});
  });

  it("converts multiple tools", () => {
    const tools = [
      { name: "tool_a", description: "A", parameters: { kind: "string" } },
      { name: "tool_b", description: "B", parameters: { kind: "number" } },
    ];
    const result = toolsToJson(tools);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "tool_a");
    assert.equal(result[1].name, "tool_b");
  });
});

// ---------------------------------------------------------------
// messagesToCC
// ---------------------------------------------------------------

describe("messagesToCC() — user messages", () => {
  it("converts string content user message", () => {
    const msgs = [{ role: "user", content: "hello" }];
    const result = messagesToCC(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, "hello");
  });

  it("passes through array content user message", () => {
    const content = [{ type: "text", text: "hello" }];
    const msgs = [{ role: "user", content }];
    const result = messagesToCC(msgs);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, content);
  });
});

describe("messagesToCC() — assistant messages", () => {
  it("converts text content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello from assistant" }],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "assistant");
    assert.deepEqual(result[0].content, [
      { type: "text", text: "Hello from assistant" },
    ]);
  });

  it("converts thinking content to reasoning", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    ];
    const result = messagesToCC(msgs);
    assert.deepEqual(result[0].content, [
      { type: "reasoning", text: "Let me think..." },
    ]);
  });

  it("converts toolCall content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123",
            name: "read_file",
            arguments: { path: "/tmp/test" },
          },
        ],
      },
    ];
    const result = messagesToCC(msgs);
    assert.deepEqual(result[0].content, [
      {
        type: "tool-call",
        toolCallId: "call_123",
        toolName: "read_file",
        input: { path: "/tmp/test" },
      },
    ]);
  });

  it("converts mixed content (thinking + text + toolCall)", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning..." },
          { type: "text", text: "result" },
          { type: "toolCall", id: "t1", name: "ls", arguments: {} },
        ],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result[0].role, "assistant");
    assert.equal(result[0].content.length, 3);
    assert.equal(result[0].content[0].type, "reasoning");
    assert.equal(result[0].content[1].type, "text");
    assert.equal(result[0].content[2].type, "tool-call");
  });
});

describe("messagesToCC() — toolResult messages", () => {
  it("converts successful tool result", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "call_123",
        toolName: "read_file",
        isError: false,
        content: [{ type: "text", text: "file contents here" }],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "tool");
    assert.equal(result[0].content[0].type, "tool-result");
    assert.equal(result[0].content[0].output.type, "text");
    assert.equal(result[0].content[0].output.value, "file contents here");
  });

  it("converts error tool result", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "call_456",
        toolName: "bad_tool",
        isError: true,
        content: [{ type: "text", text: "something went wrong" }],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result[0].content[0].output.type, "error-text");
    assert.equal(result[0].content[0].output.value, "something went wrong");
  });

  it("joins multiple text parts", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "call_789",
        toolName: "grep",
        isError: false,
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result[0].content[0].output.value, "line 1\nline 2");
  });
});

describe("messagesToCC() — full conversation", () => {
  it("handles user → assistant(toolCall) → tool → assistant", () => {
    const msgs = [
      { role: "user", content: "read /tmp/test" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I will read the file" },
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            arguments: { path: "/tmp/test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "hello world" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The file contains: hello world" }],
      },
    ];
    const result = messagesToCC(msgs);
    assert.equal(result.length, 4);
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "assistant");
    assert.equal(result[1].content.length, 2);
    assert.equal(result[2].role, "tool");
    assert.equal(result[3].role, "assistant");
    assert.equal(result[3].content[0].text, "The file contains: hello world");
  });

  it("handles empty message array", () => {
    const result = messagesToCC([]);
    assert.deepEqual(result, []);
  });
});
