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

// ── Instrumentation (side-path only; never alters tool results) ────────────────
const PROXY_STARTED_AT = new Date().toISOString();
let usageDirReady = false;

function resolveUsageLogPath() {
  if (process.env.AGY_FAST_USAGE === "0") return null;
  const raw = process.env.AGY_FAST_USAGE_LOG;
  if (raw && raw.trim()) {
    const trimmed = raw.trim();
    if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }
  if (process.env.AGY_FAST_USAGE === "1") {
    return path.join(__dirname, "usage.jsonl");
  }
  return null;
}

function mtimeIso(target) {
  try {
    return new Date(fs.statSync(target).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function versionFingerprint() {
  return {
    proxy: mtimeIso(__filename),
    adapter: mtimeIso(path.join(__dirname, "adapter.mjs")),
    upstream: mtimeIso(DEFAULT_UPSTREAM),
    pid: process.pid,
    startedAt: PROXY_STARTED_AT,
  };
}

function appendUsage(record) {
  try {
    const logPath = resolveUsageLogPath();
    if (!logPath) return;
    if (!usageDirReady) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      usageDirReady = true;
    }
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
  } catch {
    // instrumentation is a side path: never break the call
  }
}

const MAX_PENDING_CALLS = 500;

function parseToolSet(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}

function parseCliArgs(argv) {
  const out = {
    cmd: null,
    target: "generic",
    cwd: process.cwd(),
    uninstall: false,
    toolFilter: parseToolSet(process.env.AGY_FAST_TOOLS),
    upstreamArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!out.cmd && !a.startsWith("-") && (a === "init" || a === "doctor")) {
      out.cmd = a;
    } else if (a === "--target" && argv[i + 1]) {
      out.target = argv[++i];
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = path.resolve(argv[++i]);
    } else if (a === "--uninstall") {
      out.uninstall = true;
    } else if (a === "--tools" && argv[i + 1]) {
      out.toolFilter = parseToolSet(argv[++i]);
    } else if (a.startsWith("--tools=")) {
      out.toolFilter = parseToolSet(a.slice("--tools=".length));
    } else if (a === "--schema-compat" && argv[i + 1]) {
      out.upstreamArgs.push(a, argv[++i]);
    } else if (a.startsWith("--schema-compat=")) {
      out.upstreamArgs.push(a);
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

  const MAX_WRAPPER_BYTES = 51200;
  const wrapperBytes = adapterBytes + proxyBytes;
  const maxSchema = Math.max(...tools.map((t) => Buffer.byteLength(JSON.stringify(t), "utf8")));
  const snippet = generateHostContractSnippet("generic");
  const snippetBytes = Buffer.byteLength(snippet, "utf8");
  const hasCurly = snippet.includes("{") || snippet.includes("}");

  console.log(
    JSON.stringify(
      {
        ok: maxSchema <= 1280 && startupMs < 250 && !hasCurly && snippetBytes <= 1024 && wrapperBytes <= MAX_WRAPPER_BYTES,
        upstream: DEFAULT_UPSTREAM,
        coreBytes,
        wrapperBytes,
        wrapperBudgetBytes: MAX_WRAPPER_BYTES,
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
 * Dual-mode MCP Stdio forwarder supporting both NDJSON (\n) and Content-Length framing,
 * with backpressure pausing on slow consumers.
 */
function writeFramed(destWritable, text, useContentLength) {
  if (!destWritable || destWritable.destroyed || !destWritable.writable) return true;
  if (useContentLength) {
    const bytes = Buffer.byteLength(text, "utf8");
    return destWritable.write(`Content-Length: ${bytes}\r\n\r\n${text}`);
  }
  return destWritable.write(text + "\n");
}

function attachFramedForwarder(sourceReadable, destWritable, transformFrame) {
  let buffer = Buffer.alloc(0);
  let paused = false;

  const onDrain = () => {
    if (paused) {
      paused = false;
      sourceReadable.resume();
    }
  };
  destWritable.on("drain", onDrain);

  const emitText = (text, useContentLength) => {
    try {
      const ok = writeFramed(destWritable, text, useContentLength);
      if (!ok && !paused) {
        paused = true;
        sourceReadable.pause();
      }
    } catch {
      // ignore EPIPE during teardown
    }
  };

  const drainBuffer = (finalFlush = false) => {
    while (buffer.length > 0) {
      let offset = 0;
      while (offset < buffer.length && (buffer[offset] === 10 || buffer[offset] === 13)) {
        offset++;
      }
      if (offset > 0) {
        buffer = buffer.subarray(offset);
        if (buffer.length === 0) break;
      }

      const probe = buffer.subarray(0, Math.min(buffer.length, 16)).toString("latin1").toLowerCase();
      if (probe.startsWith("content-length:") || probe.startsWith("content-type:")) {
        const headerScan = buffer.subarray(0, Math.min(buffer.length, 16384)).toString("latin1");
        const sepMatch = /\r?\n\r?\n/.exec(headerScan);
        if (!sepMatch) break;
        const headerText = headerScan.slice(0, sepMatch.index);
        const clMatch = /^content-length:[ \t]*(\d+)[ \t]*\r?$/im.exec(headerText);
        if (!clMatch) {
          // Unknown/invalid header framing: pass through up to separator so upstream handles error
          const rawHeader = buffer.subarray(0, sepMatch.index + sepMatch[0].length).toString("utf8");
          buffer = buffer.subarray(sepMatch.index + sepMatch[0].length);
          emitText(rawHeader, false);
          continue;
        }
        const bodyLen = Number.parseInt(clMatch[1], 10);
        const bodyStart = Buffer.byteLength(headerText, "latin1") + sepMatch[0].length;
        if (!Number.isFinite(bodyLen) || bodyLen < 0 || buffer.length < bodyStart + bodyLen) {
          break;
        }
        const bodyText = buffer.subarray(bodyStart, bodyStart + bodyLen).toString("utf8");
        buffer = buffer.subarray(bodyStart + bodyLen);
        if (!bodyText.trim()) continue;
        const out = transformFrame(bodyText, true);
        if (out !== null && out !== undefined) {
          emitText(out, true);
        }
        continue;
      }

      const nlIdx = buffer.indexOf(10);
      if (nlIdx === -1) {
        if (finalFlush) {
          const tail = buffer.toString("utf8").replace(/\r$/, "");
          buffer = Buffer.alloc(0);
          if (tail.trim()) {
            const out = transformFrame(tail, false);
            if (out !== null && out !== undefined) emitText(out, false);
          }
        }
        break;
      }
      const line = buffer.subarray(0, nlIdx).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(nlIdx + 1);
      if (!line.trim()) continue;
      const out = transformFrame(line, false);
      if (out !== null && out !== undefined) {
        emitText(out, false);
      }
    }
  };

  sourceReadable.on("data", (chunk) => {
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? bufChunk : Buffer.concat([buffer, bufChunk]);
    drainBuffer(false);
  });

  return () => drainBuffer(true);
}

function startStdioProxy(cli = {}) {
  if (!fs.existsSync(DEFAULT_UPSTREAM)) {
    process.stderr.write(`[agyfast-universal] Upstream server missing: ${DEFAULT_UPSTREAM}\n`);
    process.exit(1);
  }

  const toolFilter = cli.toolFilter || null;
  const upstreamArgs = Array.isArray(cli.upstreamArgs) ? cli.upstreamArgs : [];
  let sessionHost = process.env.AGY_FAST_HOST?.trim() || null;
  let upstreamVersion = null;

  const childEnv =
    process.platform === "win32" && process.env.AGY_FAST_STRICT !== "1" && !process.env.PYTHONIOENCODING
      ? { ...process.env, PYTHONIOENCODING: "utf-8" }
      : process.env;
  const upstream = spawn("node", [DEFAULT_UPSTREAM, ...upstreamArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
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
    if (msg.method === "initialize" && msg.params?.clientInfo?.name && !sessionHost) {
      sessionHost = String(msg.params.clientInfo.name);
      return { mutated: false };
    }
    if (msg.method === "tools/call" && msg.params && typeof msg.params.name === "string") {
      const toolName = msg.params.name;
      if (toolFilter && !toolFilter.has(toolName) && hasValidRequestId(msg)) {
        appendUsage({
          t: new Date().toISOString(),
          tool: toolName,
          ms: 0,
          isError: true,
          sessionPid: process.pid,
          host: sessionHost || "unknown",
          version: upstreamVersion || "unknown",
        });
        return {
          mutated: false,
          localReply: {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          },
        };
      }
      const { args, notes, requestedMaxChars, validationError } = coerceToolArgs(toolName, msg.params.arguments);
      if (validationError && hasValidRequestId(msg)) {
        const localResult = postProcessToolResult(toolName, {
          isError: true,
          content: [{ type: "text", text: `Validation error: ${validationError}` }],
        });
        appendUsage({
          t: new Date().toISOString(),
          tool: toolName,
          ms: 0,
          isError: true,
          sessionPid: process.pid,
          host: sessionHost || "unknown",
          version: upstreamVersion || "unknown",
        });
        return {
          mutated: false,
          localReply: {
            jsonrpc: "2.0",
            id: msg.id,
            result: localResult,
          },
        };
      }
      let mutated = false;
      if (notes.length > 0) {
        msg.params.arguments = args;
        mutated = true;
      }
      if (hasValidRequestId(msg)) {
        trackPending(msg.id, { toolName, notes, requestedMaxChars, t0: Date.now() });
      }
      return { mutated };
    }
    const wantsSchemaRewrite =
      process.env.AGY_FAST_STRICT !== "1" &&
      (process.env.AGY_FAST_DSH_SCHEMA === "1" || process.env.AGY_FAST_ANNOTATIONS === "1");
    if (msg.method === "tools/list" && (wantsSchemaRewrite || toolFilter) && hasValidRequestId(msg)) {
      trackPending(msg.id, { kind: "tools_list", wantsSchemaRewrite });
      return { mutated: false };
    }
    if (msg.method === "notifications/cancelled" && msg.params?.requestId !== undefined) {
      pendingCalls.delete(msg.params.requestId);
    }
    return { mutated: false };
  };

  const transformOneOutbound = (msg) => {
    // initialize: record upstream version and stamp running code version into serverInfo
    if (msg.result && msg.result.protocolVersion !== undefined) {
      if (typeof msg.result.serverInfo?.version === "string") {
        upstreamVersion = msg.result.serverInfo.version;
      }
      if (process.env.AGY_FAST_STRICT !== "1") {
        const info = msg.result.serverInfo && typeof msg.result.serverInfo === "object" ? msg.result.serverInfo : {};
        info.agyfast = versionFingerprint();
        msg.result.serverInfo = info;
        return true;
      }
      return false;
    }
    if (hasValidRequestId(msg) && pendingCalls.has(msg.id)) {
      const meta = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      if (msg.result) {
        if (meta.kind === "tools_list") {
          let nextResult = meta.wantsSchemaRewrite ? processToolsListResult(msg.result) : msg.result;
          if (toolFilter && Array.isArray(nextResult?.tools)) {
            nextResult = {
              ...nextResult,
              tools: nextResult.tools.filter((t) => t && toolFilter.has(t.name)),
            };
          }
          msg.result = nextResult;
          return true;
        }
        msg.result = postProcessToolResult(meta.toolName, msg.result, meta);
        if (meta.toolName) {
          appendUsage({
            t: new Date().toISOString(),
            tool: meta.toolName,
            ms: typeof meta.t0 === "number" ? Date.now() - meta.t0 : null,
            isError: msg.result.isError === true,
            sessionPid: process.pid,
            host: sessionHost || "unknown",
            version: upstreamVersion || "unknown",
          });
        }
        return true;
      }
      if (msg.error && meta.toolName) {
        appendUsage({
          t: new Date().toISOString(),
          tool: meta.toolName,
          ms: typeof meta.t0 === "number" ? Date.now() - meta.t0 : null,
          isError: true,
          sessionPid: process.pid,
          host: sessionHost || "unknown",
          version: upstreamVersion || "unknown",
        });
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

  const flushIn = attachFramedForwarder(process.stdin, upstream.stdin, (line, useContentLength) => {
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
          writeFramed(process.stdout, JSON.stringify(localReplies), useContentLength);
        }
        if (forwardItems.length === 0) return null;
        return changed || localReplies.length > 0 ? JSON.stringify(forwardItems) : line;
      }
      const r = transformOneInbound(msg);
      if (r.localReply) {
        writeFramed(process.stdout, JSON.stringify(r.localReply), useContentLength);
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
  startStdioProxy(cli);
}
