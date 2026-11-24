import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, "proxy.mjs");
const TMP = path.join(__dirname, "_test_tmp");

class ProxyMcpTestClient {
  constructor(extraEnv = {}) {
    this.nextId = 0; // Explicitly start at id=0 to catch falsy id bugs
    this.pending = new Map();
    this.buf = "";
    this.proc = spawn("node", [PROXY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString();
      const lines = this.buf.split("\n");
      this.buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch {}
      }
    });
  }
  req(method, params, useCrlf = false) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      const eol = useCrlf ? "\r\n" : "\n";
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + eol);
    });
  }
  async init() {
    await this.req("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "proxy-test", version: "1.0" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return this.req("tools/list", {});
  }
  async call(name, args) {
    const res = await this.req("tools/call", { name, arguments: args });
    return {
      isError: Boolean(res.result?.isError),
      text: (res.result?.content || []).map((c) => c.text || "").join("\n"),
    };
  }
  stop() {
    this.proc.kill();
  }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const lines = Array.from({ length: 35 }, (_, i) => (i === 24 ? "export const VAL = 'old';" : `// line ${i + 1}`));
  fs.writeFileSync(path.join(TMP, "sample.js"), lines.join("\n") + "\n", "utf8");

  // 1. Default enhanced proxy mode (also tests id=0 during initialize and CRLF framing)
  const client = new ProxyMcpTestClient();
  const listRes = await client.init();
  assert.equal(listRes.result.tools.length, 5, "Should expose exact 5 upstream tools");
  for (const t of listRes.result.tools) {
    const bytes = Buffer.byteLength(JSON.stringify(t), "utf8");
    assert.ok(bytes <= 1280, `Schema ${t.name} exceeded 1280B: ${bytes}`);
  }

  // Test id: 0 on tools/call + CRLF framing explicitly
  const zeroIdClient = new ProxyMcpTestClient();
  const zeroRes = await zeroIdClient.req("tools/call", { name: "quick_outline", arguments: { cwd: TMP, paths: "sample.js" } }, true);
  assert.equal(zeroRes.id, 0);
  assert.ok((zeroRes.result?.content?.[0]?.text || "").includes("paths->array"), "id=0 + CRLF must correlate and coerce");
  zeroIdClient.stop();

  // C1: bare string paths
  const outRes = await client.call("quick_outline", { cwd: TMP, paths: "sample.js" });
  assert.equal(outRes.isError, false, outRes.text);
  assert.ok(outRes.text.includes("paths->array"));

  // C2: bare string lineRanges
  const sliceRes = await client.call("read_slices", { cwd: TMP, lineRanges: "sample.js:24-26" });
  assert.equal(sliceRes.isError, false, sliceRes.text);
  assert.ok(sliceRes.text.includes("VAL"));

  // C5 (B1): create via empty-target hunk
  const createRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "created.js", hunks: [{ target: "", replacement: "export const a = 1;\n" }] }],
  });
  assert.equal(createRes.isError, false, createRes.text);
  assert.equal(fs.readFileSync(path.join(TMP, "created.js"), "utf8"), "export const a = 1;\n");

  // C4 + C6 (B4): oldText alias + startLine drift autoRange
  const editRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [
      {
        path: "sample.js",
        hunks: [{ oldText: "export const VAL = 'old';", newText: "export const VAL = 'new';", startLine: 1, endLine: 10 }],
      },
    ],
  });
  assert.equal(editRes.isError, false, editRes.text);
  assert.ok(editRes.text.includes("autoRange@L25"));
  assert.ok(fs.readFileSync(path.join(TMP, "sample.js"), "utf8").includes("VAL = 'new'"));

  // Error path includes 1-line Example (both hard isError AND P1 soft errors)
  const errRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "sample.js", hunks: [{ target: "MISSING_NEEDLE", replacement: "x" }] }],
  });
  assert.equal(errRes.isError, true);
  assert.ok(errRes.text.includes("Example:"));

  // P1: Soft errors (isError=false) from batch_search invalid regex, read_slices ENOENT, run_checks exit!=0
  const softRegex = await client.call("batch_search", {
    cwd: TMP,
    queries: [{ type: "regex", pattern: "([unclosed" }],
  });
  assert.equal(softRegex.isError, false);
  assert.ok(softRegex.text.includes("Example:"), `Expected Example on soft regex error: ${softRegex.text}`);

  const softSlice = await client.call("read_slices", { cwd: TMP, lineRanges: ["nope_missing.txt:1-5"] });
  assert.ok(softSlice.text.includes("Example:"), `Expected Example on soft ENOENT error: ${softSlice.text}`);

  const softCmd = await client.call("run_checks", {
    cwd: TMP,
    commands: [{ name: "failcmd", command: 'node -e "process.exit(3)"' }],
  });
  assert.ok(softCmd.text.includes("Example:"), `Expected Example on soft run_checks FAIL: ${softCmd.text}`);

  // P2: maxChars < upstream clamp strictly respected with surrogate-safe Head-Tail folding (no U+FFFD)
  fs.writeFileSync(path.join(TMP, "emoji.txt"), "😀".repeat(60) + "\nEND_OK\n", "utf8");
  const clamped = await client.call("batch_search", {
    cwd: TMP,
    queries: [{ type: "text", pattern: "line" }],
    maxChars: 90,
  });
  assert.ok(clamped.text.length <= 90, `Expected <=90 chars, got ${clamped.text.length}: ${clamped.text}`);
  assert.ok(!clamped.text.includes("\uFFFD"), "Should never introduce replacement char");

  const emojiSlice = await client.call("read_slices", {
    cwd: TMP,
    lineRanges: ["emoji.txt:1-2"],
    maxChars: 80,
  });
  assert.ok(emojiSlice.text.length <= 80, `Expected <=80 chars, got ${emojiSlice.text.length}`);
  assert.ok(!emojiSlice.text.includes("\uFFFD"), "Surrogate-safe Head-Tail must not split emoji");

  // Guarded B1: do NOT create files inside non-existent parent dirs
  const ghostDirRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "typo_nonexistent_dir/ghost.js", hunks: [{ target: "", replacement: "x" }] }],
  });
  assert.equal(ghostDirRes.isError, true, "Missing parent dir must fail instead of creating stray dirs");
  assert.equal(fs.existsSync(path.join(TMP, "typo_nonexistent_dir")), false);

  // Guarded B4: replaceAll:true MUST NOT widen startLine/endLine fence
  fs.writeFileSync(path.join(TMP, "fence.js"), "// L1\n// L2\nconst k = 1;\n", "utf8");
  const fenceRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [
      {
        path: "fence.js",
        hunks: [{ target: "const k = 1;", replacement: "const k = 2;", startLine: 1, endLine: 2, replaceAll: true }],
      },
    ],
  });
  assert.equal(fenceRes.isError, true, "replaceAll with explicit range must NOT auto-widen");
  assert.ok(fs.readFileSync(path.join(TMP, "fence.js"), "utf8").includes("const k = 1;"));

  // Overlap-aware autoRange guard: "aaa" contains 2 overlapping "aa" -> must NOT auto-widen
  fs.writeFileSync(path.join(TMP, "overlap.txt"), "// hdr\n// sub\naaa\n", "utf8");
  const overlapRes = await client.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "overlap.txt", hunks: [{ target: "aa", replacement: "bb", startLine: 1, endLine: 2 }] }],
  });
  assert.equal(overlapRes.isError, true, "Overlapping matches must reject autoRange");

  // No false positive on indented code search hits containing "ERROR:"
  fs.writeFileSync(path.join(TMP, "log_code.js"), "function f() {\n  // ERROR: simulated log\n}\n", "utf8");
  const cleanSearch = await client.call("batch_search", {
    cwd: TMP,
    queries: [{ type: "text", path: "log_code.js", pattern: "ERROR:" }],
  });
  assert.ok(!cleanSearch.text.includes("Example:"), "Indented search hit must not trigger Example:");

  // Soft error + maxChars hard cap invariant (error + Example must still <= maxChars)
  const softBounded = await client.call("batch_search", {
    cwd: TMP,
    queries: [{ type: "regex", pattern: "([unclosed" }],
    maxChars: 140,
  });
  assert.ok(softBounded.text.length <= 140, `Expected <=140, got ${softBounded.text.length}`);
  assert.ok(softBounded.text.includes("Example:"), "Should preserve Example inside maxChars budget");

  // P2 extreme small value guard (<40 returns clean error instead of broken fragment)
  const tinyCap = await client.call("read_slices", { cwd: TMP, lineRanges: ["sample.js:1-3"], maxChars: 20 });
  assert.equal(tinyCap.isError, true, "maxChars < 40 should return clear error instead of broken fragment");
  assert.ok(tinyCap.text.includes("too small (<40)"));

  // P3: Chained hunk hint on hunk #2 failure (explicit full Note assertion)
  const chained = await client.call("apply_edits", {
    cwd: TMP,
    edits: [
      {
        path: "sample.js",
        hunks: [
          { target: "// line 1", replacement: "// line 1_A" },
          { target: "// line 1_A", replacement: "// line 1_B" },
        ],
      },
    ],
  });
  assert.ok(
    chained.text.includes("Note: multiple hunks in one call match the original file in parallel"),
    `Expected explicit P3 Note: ${chained.text}`
  );

  // Upstream #74 alignment: reject boolean/null/broken-JSON strings and conflicting target/alias fields
  const boolStr = await client.call("quick_outline", { cwd: TMP, paths: "true" });
  assert.equal(boolStr.isError, true, "Literal 'true' must trigger corruption validation instead of coercing");
  const brokenJsonStr = await client.call("read_slices", { cwd: TMP, lineRanges: "[broken" });
  assert.equal(brokenJsonStr.isError, true, "Malformed '[broken' string must fail validation");
  const conflictAlias = await client.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "sample.js", hunks: [{ target: "A", oldText: "B", replacement: "C" }] }],
  });
  assert.equal(conflictAlias.isError, true, "Conflicting target vs oldText must reject explicitly");
  assert.ok(conflictAlias.text.includes("Conflicting target") && conflictAlias.text.includes("Example:"));

  client.stop();

  // 1b. AGY_FAST_QUIET=1 suppresses success tag while keeping error Example
  const quietClient = new ProxyMcpTestClient({ AGY_FAST_QUIET: "1" });
  await quietClient.init();
  const quietOut = await quietClient.call("quick_outline", { cwd: TMP, paths: "sample.js" });
  assert.equal(quietOut.isError, false);
  assert.ok(!quietOut.text.includes("[agyfast-universal:"), "QUIET mode should omit success tag");
  quietClient.stop();

  // 2. Strict mode kill-switch (AGY_FAST_STRICT=1) behaves exactly like raw upstream
  const strictClient = new ProxyMcpTestClient({ AGY_FAST_STRICT: "1" });
  await strictClient.init();
  const strictOut = await strictClient.call("quick_outline", { cwd: TMP, paths: "sample.js" });
  assert.equal(strictOut.isError, true, "Strict mode should reject bare string paths");
  strictClient.stop();

  // 3. CLI init & --uninstall lossless cleanup
  const initDir = path.join(TMP, "proj_claude");
  fs.mkdirSync(initDir, { recursive: true });
  fs.writeFileSync(path.join(initDir, "CLAUDE.md"), "# Existing Rules\nKeep me.\n", "utf8");
  const initSpawn = spawn("node", [PROXY, "init", "--target", "claude-code", "--cwd", initDir], { stdio: "pipe" });
  await new Promise((r) => initSpawn.on("exit", r));
  const claudeContent = fs.readFileSync(path.join(initDir, "CLAUDE.md"), "utf8");
  assert.ok(claudeContent.includes("Keep me.") && claudeContent.includes("<!-- agy-fast:start -->"));
  assert.ok(!claudeContent.includes("{") && !claudeContent.includes("}"), "No curly braces allowed");
  const mcpJson = JSON.parse(fs.readFileSync(path.join(initDir, ".mcp.json"), "utf8"));
  assert.ok(mcpJson.mcpServers["agy-fast"]);

  const uninstSpawn = spawn("node", [PROXY, "init", "--target", "claude-code", "--cwd", initDir, "--uninstall"], { stdio: "pipe" });
  await new Promise((r) => uninstSpawn.on("exit", r));
  const claudeAfter = fs.readFileSync(path.join(initDir, "CLAUDE.md"), "utf8");
  assert.equal(claudeAfter.trim(), "# Existing Rules\nKeep me.");

  // 4. AGY_FAST_DSH_SCHEMA=1 + AGY_FAST_ANNOTATIONS=1 stays <=1280B and yields full DSH PTC TS types
  const dshClient = new ProxyMcpTestClient({ AGY_FAST_DSH_SCHEMA: "1", AGY_FAST_ANNOTATIONS: "1" });
  await dshClient.init();
  const dshListRes = await dshClient.req("tools/list", {});
  const toolsList = dshListRes.result?.tools || [];
  assert.equal(toolsList.length, 5);
  for (const t of toolsList) {
    const dshBytes = Buffer.byteLength(JSON.stringify(t), "utf8");
    assert.ok(dshBytes <= 1280, `DSH schema ${t.name} exceeded 1280B: ${dshBytes}`);
  }
  const dshApplyTool = toolsList.find((t) => t.name === "apply_edits");
  assert.ok(
    dshApplyTool?.description?.includes("input size unrestricted"),
    "apply_edits description in DSH mode should clarify input size is unrestricted"
  );
  const rawToolsText = JSON.stringify(toolsList);
  for (const banned of ['"minimum"', '"maximum"', '"minItems"', '"maxItems"', '"$schema"']) {
    assert.ok(!rawToolsText.includes(banned), `Sanitized tools/list must omit ${banned}`);
  }
  const npmRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "node_modules",
    "@deepseek-ai"
  );
  const ptcPath = path.join(npmRoot, "dsh-tool-executor-ptc", "lib", "types", "ts-types.js");
  const toolsPkgPath = path.join(npmRoot, "dsh-tools", "lib", "index.js");
  if (fs.existsSync(ptcPath) && fs.existsSync(toolsPkgPath)) {
    const ptc = await import(new URL(`file:///${ptcPath.replace(/\\/g, "/")}`));
    const dshTools = await import(new URL(`file:///${toolsPkgPath.replace(/\\/g, "/")}`));
    for (const tool of toolsList) {
      dshTools.assertSupportedJsonSchema(tool.inputSchema);
      const ts = ptc.jsonSchemaToTs(tool.inputSchema, 1);
      assert.notEqual(ts.trim(), "unknown", `${tool.name} must compile to TS interface, not unknown`);
    }
    const bsTool = toolsList.find((t) => t.name === "batch_search");
    assert.equal(bsTool?.annotations?.readOnlyHint, true, "batch_search must carry MCP readOnlyHint annotation");
  }
  dshClient.stop();

  // 5. Cross-host B8 file:// URI normalization (#L fragment + cwd + defaultCwd fallback)
  const { pathToFileURL } = await import("node:url");
  const uriClient = new ProxyMcpTestClient({ AGY_FAST_DEFAULT_CWD: TMP });
  await uriClient.init();
  const sampleFile = path.join(TMP, "sample.js");
  const sampleUrl = pathToFileURL(sampleFile).href;
  const uriSlice = await uriClient.call("read_slices", {
    lineRanges: `${sampleUrl}#L1-L2`,
  });
  assert.equal(uriSlice.isError, false, `Expected file://#L1-L2 + defaultCwd to pass: ${uriSlice.text}`);
  assert.ok(uriSlice.text.includes("defaultCwd") && uriSlice.text.includes("fileUri->path"));
  uriClient.stop();

  // 6. Instrumentation: serverInfo.agyfast fingerprint (strict-gated) + opt-in usage log
  const initPayload = {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "proxy-test", version: "1.0" },
  };
  const initMetaClient = new ProxyMcpTestClient({});
  const initMetaRes = await initMetaClient.req("initialize", initPayload);
  const fp = initMetaRes.result?.serverInfo?.agyfast;
  assert.ok(fp && typeof fp.proxy === "string" && typeof fp.adapter === "string" && fp.pid, "Missing serverInfo.agyfast");
  initMetaClient.stop();

  const strictMetaClient = new ProxyMcpTestClient({ AGY_FAST_STRICT: "1" });
  const strictMetaRes = await strictMetaClient.req("initialize", initPayload);
  assert.equal(strictMetaRes.result?.serverInfo?.agyfast, undefined, "Strict mode must not inject serverInfo.agyfast");
  strictMetaClient.stop();

  const usageLogFile = path.join(TMP, "logs", "usage.jsonl");
  const usageClient = new ProxyMcpTestClient({ AGY_FAST_USAGE_LOG: usageLogFile });
  await usageClient.init();
  await usageClient.call("quick_outline", { cwd: TMP, paths: "sample.js" });
  await usageClient.call("quick_outline", { cwd: TMP, paths: "true" });
  usageClient.stop();
  const usageLines = fs.readFileSync(usageLogFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(usageLines.length, 2, "Expected 2 usage log entries");
  assert.equal(usageLines[0].tool, "quick_outline");
  assert.equal(usageLines[0].isError, false);
  assert.equal(usageLines[1].isError, true);

  // 7. >20KB single create call + Windows semicolon N1 fix (run_checks & apply_edits.verify) + UTF-8 output
  const { coerceWindowsCommandSemicolons } = await import("./adapter.mjs");
  assert.equal(
    coerceWindowsCommandSemicolons("python a.py; python b.py;", "win32").value,
    "python a.py && python b.py"
  );
  assert.equal(
    coerceWindowsCommandSemicolons('python -c "import a; print(1)"', "win32").changed,
    false
  );
  assert.equal(
    coerceWindowsCommandSemicolons("$x = 1; Write-Host $x", "win32").changed,
    false
  );

  const largeClient = new ProxyMcpTestClient({});
  await largeClient.init();
  const largeHtml = "<!doctype html>\n<html><body>\n" + "<p>Hello Oil Paper Umbrella</p>\n".repeat(700) + "</body></html>\n";
  assert.ok(Buffer.byteLength(largeHtml, "utf8") > 20000, "Test fixture must exceed 20KB");
  const singleWriteLarge = await largeClient.call("apply_edits", {
    cwd: TMP,
    edits: [{ path: "large_page.html", create: largeHtml, overwrite: true }],
    verify: 'node -e "console.log(\'V1;ok\')"; node -e "console.log(\'V2_PASS\')"',
  });
  assert.equal(singleWriteLarge.isError, false, `Single >20KB create + verify failed: ${singleWriteLarge.text}`);
  assert.equal(fs.readFileSync(path.join(TMP, "large_page.html"), "utf8").length, largeHtml.length);
  if (process.platform === "win32") {
    assert.ok(singleWriteLarge.text.includes("win32 ';'=>'&&'"), "Expected win32 semicolon note on verify");
  }

  const multiCmdCheck = await largeClient.call("run_checks", {
    cwd: TMP,
    outputMode: "full",
    commands: [
      'node -e "console.log(\'INNER;KEPT\')"; node -e "console.log(\'UTF8:\\u2212\');"',
    ],
  });
  assert.equal(multiCmdCheck.isError, false, `run_checks semicolon failed: ${multiCmdCheck.text}`);
  assert.ok(
    multiCmdCheck.text.includes("INNER;KEPT") && multiCmdCheck.text.includes("UTF8:\u2212"),
    `Expected both commands & UTF-8 minus in output: ${multiCmdCheck.text}`
  );
  largeClient.stop();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("ALL PROXY + STRICT + DSH SCHEMA + URI/ANNOTATIONS + INSTRUMENTATION + WIN32_N1 + 20KB + INIT TESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
