#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  coerceToolArgs,
  generateHostContractSnippet,
  postProcessToolResult,
  processToolsListResult,
  runInit,
} from "./adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UPSTREAM =
  process.env.AGY_FAST_UPSTREAM ||
  path.join(os.homedir(), ".gemini", "config", "plugins", "agy-fast", "dist", "mcp-server.mjs");

const MAX_PENDING_CALLS = 500;

function parseCliArgs(argv) {
  const out = { cmd: null, target: "generic", cwd: process.cwd(), uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!out.cmd && !a.startsWith("-")) {
      out.cmd = a;
    } else if (a === "--target" && argv[i + 1]) {
      out.target = argv[++i];
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = path.resolve(argv[++i]);
    } else if (a === "--uninstall") {
      out.uninstall = true;
    }
  }
  return out;
}

function hasValidRequestId(msg) {
  return Boolean(msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null);
}

async function runDoctor() {
  if (!fs.existsSync(DEFAULT_UPSTREAM)) {
    console.error(`Upstream MCP server not found: ${DEFAULT_UPSTREAM}`);
    process.exit(1);
  }
  const adapterBytes = fs.statSync(path.join(__dirname, "adapter.mjs")).size;
  const proxyBytes = fs.statSync(__filename).size;
  const coreBytes = fs.statSync(DEFAULT_UPSTREAM).size;
  const deltaPct = (((adapterBytes + proxyBytes) / coreBytes) * 100).toFixed(2);

  const t0 = performance.now();
  const child = spawn("node", [DEFAULT_UPSTREAM], { stdio: ["pipe", "pipe", "pipe"] });
  const dec = new StringDecoder("utf8");
  let buf = "";
  const tools = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Upstream handshake timed out"));
    }, 4000);
    child.stdout.on("data", (d) => {
      buf += dec.write(d);
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
          } else if (msg.id === 2) {
            clearTimeout(timer);
            resolve(msg.result?.tools || []);
          }
        } catch {
          // ignore non-json
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "1.0" } },
      }) + "\n"
    );
  });
  const startupMs = Number((performance.now() - t0).toFixed(1));
  child.kill();

  const maxSchema = Math.max(...tools.map((t) => Buffer.byteLength(JSON.stringify(t), "utf8")));
  const snippet = generateHostContractSnippet("generic");
  const snippetBytes = Buffer.byteLength(snippet, "utf8");
  const hasCurly = snippet.includes("{") || snippet.includes("}");

  console.log(
    JSON.stringify(
      {
        ok: maxSchema <= 1280 && startupMs < 250 && !hasCurly && snippetBytes <= 1024,
        upstream: DEFAULT_UPSTREAM,
        coreBytes,
        wrapperBytes: adapterBytes + proxyBytes,
        deltaPct: `${deltaPct}%`,
        startupMs,
        maxToolSchemaBytes: maxSchema,
        snippetBytes,
        hasCurlyBraces: hasCurly,
        strictMode: process.env.AGY_FAST_STRICT === "1",
        quietMode: process.env.AGY_FAST_QUIET === "1",
        autoRangeEnabled: process.env.AGY_FAST_AUTORANGE !== "0",
      },
      null,
      2
    )
  );
}

/**
 * Backpressure-aware newline-delimited JSON-RPC pipe helper.
 * Pauses sourceReadable whenever destWritable.write() returns false until 'drain' fires.
 */
function attachFramedForwarder(sourceReadable, destWritable, transformLine) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  let paused = false;

  const onDrain = () => {
    if (paused) {
      paused = false;
      sourceReadable.resume();
    }
  };
  destWritable.on("drain", onDrain);

  const writeLine = (lineStr) => {
    try {
      if (!destWritable.destroyed && destWritable.writable) {
        const ok = destWritable.write(lineStr + "\n");
        if (!ok && !paused) {
          paused = true;
          sourceReadable.pause();
        }
      }
    } catch {
      // ignore EPIPE during teardown
    }
  };

  const flushLines = (finalFlush = false) => {
    if (finalFlush) buf += dec.end();
    const lines = buf.split("\n");
    buf = finalFlush ? "" : lines.pop() || "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const out = transformLine(line);
      if (out !== null && out !== undefined) {
        writeLine(out);
      }
    }
  };

  sourceReadable.on("data", (chunk) => {
    buf += dec.write(chunk);
    flushLines(false);
  });

  return () => flushLines(true);
}

function startStdioProxy() {
  if (!fs.existsSync(DEFAULT_UPSTREAM)) {
    process.stderr.write(`[agyfast-universal] Upstream server missing: ${DEFAULT_UPSTREAM}\n`);
    process.exit(1);
  }

  const upstream = spawn("node", [DEFAULT_UPSTREAM], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const pendingCalls = new Map();
  const trackPending = (id, meta) => {
    if (pendingCalls.size >= MAX_PENDING_CALLS) {
      const oldestKey = pendingCalls.keys().next().value;
      if (oldestKey !== undefined) pendingCalls.delete(oldestKey);
    }
    pendingCalls.set(id, meta);
  };

  process.stdout.on("error", () => {});
  upstream.stdin.on("error", () => {});
  upstream.on("error", (err) => {
    process.stderr.write(`[agyfast-universal] Upstream spawn error: ${err.message}\n`);
    process.exit(1);
  });

  upstream.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const transformOneInbound = (msg) => {
    if (!msg || typeof msg !== "object") return { mutated: false };
    if (msg.method === "tools/call" && msg.params && typeof msg.params.name === "string") {
      const toolName = msg.params.name;
      const { args, notes, requestedMaxChars, validationError } = coerceToolArgs(toolName, msg.params.arguments);
      if (validationError && hasValidRequestId(msg)) {
        return {
          mutated: false,
          localReply: {
            jsonrpc: "2.0",
            id: msg.id,
            result: postProcessToolResult(toolName, {
              isError: true,
              content: [{ type: "text", text: `Validation error: ${validationError}` }],
            }),
          },
        };
      }
      let mutated = false;
      if (notes.length > 0) {
        msg.params.arguments = args;
        mutated = true;
      }
      if (hasValidRequestId(msg)) {
        trackPending(msg.id, { toolName, notes, requestedMaxChars });
      }
      return { mutated };
    }
    if (
      msg.method === "tools/list" &&
      process.env.AGY_FAST_STRICT !== "1" &&
      (process.env.AGY_FAST_DSH_SCHEMA === "1" || process.env.AGY_FAST_ANNOTATIONS === "1") &&
      hasValidRequestId(msg)
    ) {
      trackPending(msg.id, { kind: "tools_list" });
      return { mutated: false };
    }
    if (msg.method === "notifications/cancelled" && msg.params?.requestId !== undefined) {
      pendingCalls.delete(msg.params.requestId);
    }
    return { mutated: false };
  };

  const transformOneOutbound = (msg) => {
    if (hasValidRequestId(msg) && pendingCalls.has(msg.id)) {
      const meta = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      if (msg.result) {
        if (meta.kind === "tools_list") {
          msg.result = processToolsListResult(msg.result);
          return true;
        }
        msg.result = postProcessToolResult(meta.toolName, msg.result, meta);
        return true;
      }
    }
    return false;
  };

  const flushUp = attachFramedForwarder(upstream.stdout, process.stdout, (line) => {
    try {
      const msg = JSON.parse(line);
      const changed = Array.isArray(msg)
        ? msg.reduce((acc, item) => transformOneOutbound(item) || acc, false)
        : transformOneOutbound(msg);
      return changed ? JSON.stringify(msg) : line;
    } catch {
      return line;
    }
  });

  const flushIn = attachFramedForwarder(process.stdin, upstream.stdin, (line) => {
    try {
      const msg = JSON.parse(line);
      if (Array.isArray(msg)) {
        let changed = false;
        const forwardItems = [];
        const localReplies = [];
        for (const item of msg) {
          const r = transformOneInbound(item);
          if (r.localReply) {
            localReplies.push(r.localReply);
          } else {
            if (r.mutated) changed = true;
            forwardItems.push(item);
          }
        }
        if (localReplies.length > 0) {
          process.stdout.write(JSON.stringify(localReplies) + "\n");
        }
        if (forwardItems.length === 0) return null;
        return changed || localReplies.length > 0 ? JSON.stringify(forwardItems) : line;
      }
      const r = transformOneInbound(msg);
      if (r.localReply) {
        process.stdout.write(JSON.stringify(r.localReply) + "\n");
        return null;
      }
      return r.mutated ? JSON.stringify(msg) : line;
    } catch {
      return line;
    }
  });

  upstream.stdout.on("end", () => flushUp());

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    flushIn();
    try {
      if (!upstream.stdin.destroyed) upstream.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        if (!upstream.killed) upstream.kill();
      } catch {}
    }, 150).unref();
  };

  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("exit", () => {
    try {
      if (!upstream.killed) upstream.kill();
    } catch {}
  });

  upstream.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

const cli = parseCliArgs(process.argv.slice(2));
if (cli.cmd === "init") {
  const res = runInit({
    target: cli.target,
    cwd: cli.cwd,
    proxyPath: __filename,
    uninstall: cli.uninstall,
  });
  console.log(JSON.stringify(res, null, 2));
} else if (cli.cmd === "doctor") {
  runDoctor().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  startStdioProxy();
}
