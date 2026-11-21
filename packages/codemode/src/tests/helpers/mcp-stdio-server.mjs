// A real MCP server on stdio, for tests that start one as a process. It
// offers `echo` (returns its arguments), `env` (returns its environment's
// names), `fail` (reports its own failure), and `grow`, which adds a tool
// named `grown` and announces the change. It writes its pid to the file
// named by its first argument, when given one, so a test can see the
// process end. With `FIXTURE_FAULT=garble`, `echo` first prints a line
// that is not JSON-RPC; with `FIXTURE_FAULT=crash`, it prints why to stderr
// and exits without answering.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));

const tools = [
  {
    name: "echo",
    description: "Return the arguments",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "env",
    description: "Environment variable names",
    inputSchema: { type: "object" },
  },
  {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object" },
  },
  { name: "grow", description: "Add a tool", inputSchema: { type: "object" } },
];

const text = (value) => ({ content: [{ type: "text", text: value }] });

function call(name, args) {
  if (name === "echo") {
    if (process.env.FIXTURE_FAULT === "garble")
      process.stdout.write("starting up...\n");
    if (process.env.FIXTURE_FAULT === "crash") {
      process.stderr.write("fatal: out of disk\n");
      process.exit(3);
    }
    return { ...text(args.text), structuredContent: args };
  }
  if (name === "env")
    return {
      ...text("env"),
      structuredContent: { names: Object.keys(process.env).sort() },
    };
  if (name === "fail") return { ...text("the tool said no"), isError: true };
  if (name === "grow") {
    tools.push({
      name: "grown",
      description: "Added later",
      inputSchema: { type: "object" },
    });
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
    );
    return text("grew");
  }
  return { ...text(`unknown tool ${name}`), isError: true };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) =>
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
    );
  if (message.method === "initialize")
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "stdio-fixture", version: "0.1.0" },
      instructions: "A fixture server.",
    });
  else if (message.method === "tools/list") reply({ tools });
  else if (message.method === "tools/call")
    reply(call(message.params.name, message.params.arguments ?? {}));
  else if (message.method === "ping") reply({});
  else
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`,
    );
});
