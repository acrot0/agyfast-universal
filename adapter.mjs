import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Zero-dependency boundary coercion, guarded autoRange, soft/hard error self-healing,
 * surrogate-safe Head-Tail maxChars folding, and cross-agent config distribution.
 */

export const START_MARKER = "<!-- agy-fast:start -->";
export const END_MARKER = "<!-- agy-fast:end -->";

const ONE_LINE_EXAMPLES = {
  batch_search: 'Example: {"cwd":"/abs/dir","queries":[{"type":"text","pattern":"foo"}]}',
  quick_outline: 'Example: {"cwd":"/abs/dir","paths":["src/a.ts"]}',
  read_slices: 'Example: {"cwd":"/abs/dir","lineRanges":["src/a.ts:1-60"]}',
  apply_edits:
    'Example: {"cwd":"/abs/dir","edits":[{"path":"src/a.ts","hunks":[{"target":"old","replacement":"new"}]}]} (create: {"path":"a.ts","create":"..."})',
  run_checks: 'Example: {"cwd":"/abs/dir","commands":[{"command":"npm test"}]}',
};

const MD_FILE_LINK_RE = /^\[[^\]]*\]\((file:\/\/[^)\s]+)\)$/i;

function unwrapFileReference(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  const md = MD_FILE_LINK_RE.exec(trimmed);
  return md ? md[1] : trimmed;
}

function parseStringArray(val, splitCommasWithColon = false) {
  if (Array.isArray(val)) return val;
  if (typeof val !== "string") return val;
  const s = val.trim();
  if (!s) return [];
  // Unwrap single Markdown [label](file:///...) before `[` JSON array check
  if (MD_FILE_LINK_RE.test(s)) {
    return [s];
  }
  // Per upstream maintainer #74 feedback: NEVER coerce literal booleans/null or malformed JSON fragments
  if (/^(?:true|false|null)$/i.test(s) || s.startsWith("{")) {
    return val;
  }
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return val;
    }
    return val;
  }
  if (splitCommasWithColon && s.includes(",")) {
    const parts = s
      .split(/,\s*(?=[^,:\s]+:\d)/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return [s];
}

/** Early-exit overlap-safe check: returns line of first match ONLY if count === 1, else null. */
function findUniqueMatchLine(text, needle) {
  if (!needle) return null;
  const first = text.indexOf(needle);
  if (first === -1) return null;
  // Advance by +1 (overlap-aware) so "aaa" matching "aa" detects >=2 occurrences
  if (text.indexOf(needle, first + 1) !== -1) return null;
  return text.slice(0, first).split("\n").length;
}

/** Avoid slicing in the middle of a UTF-16 surrogate pair (prevents U+FFFD replacement chars). */
function safeSliceStart(str, maxLen) {
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  let end = maxLen;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, Math.max(0, end));
}

function safeSliceEnd(str, maxLen) {
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  let start = str.length - maxLen;
  const code = str.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return str.slice(start);
}

function isProbablyBinaryFile(absPath) {
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.allocUnsafe(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

export function hasSoftErrorText(text) {
  if (!text || typeof text !== "string") return false;
  return /(?:^|\n)(?:  )?ERROR:|(?:^|\n)## \[FAIL\b|\bChecks:\s*\d+\/\d+\s+passed,\s*[1-9]\d*\s+failed|(?:^|\n)(?:Atomic edit aborted|Partial edit applied|Validation failed)/m.test(
    text
  );
}

/** Surrogate-safe Head-Tail folding so both root cause and summary remain visible within maxChars. */
function enforceMaxChars(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const marker = `\n...[folded ${text.length - maxChars} chars]...\n`;
  if (maxChars <= marker.length + 16) {
    return safeSliceStart(text, maxChars);
  }
  const avail = maxChars - marker.length;
  const headBudget = Math.ceil(avail * 0.65);
  const tailBudget = avail - headBudget;
  return safeSliceStart(text, headBudget) + marker + safeSliceEnd(text, tailBudget);
}

function normalizeFileUri(val) {
  const raw = unwrapFileReference(val);
  if (typeof raw !== "string" || !/^file:\/\//i.test(raw)) return { value: val, changed: false };
  try {
    return { value: fileURLToPath(raw), changed: true };
  } catch {
    let stripped = raw.replace(/#.*$/, "").replace(/^file:\/\/(?:localhost)?\/?/i, "");
    if (!/^[A-Za-z]:[\\/]/.test(stripped) && !stripped.startsWith("/") && !stripped.startsWith("\\\\")) {
      stripped = "/" + stripped;
    }
    try {
      stripped = decodeURIComponent(stripped);
    } catch {}
    return { value: stripped, changed: true };
  }
}

function normalizeFileUriArray(arr, notes) {
  if (!Array.isArray(arr)) return;
  let changed = false;
  for (let i = 0; i < arr.length; i++) {
    const r = normalizeFileUri(arr[i]);
    if (r.changed) {
      arr[i] = r.value;
      changed = true;
    }
  }
  if (changed) notes.push("fileUri->path");
}

function normalizeLineRangeUri(val) {
  const raw = unwrapFileReference(val);
  if (typeof raw !== "string" || !/^file:\/\//i.test(raw)) return { value: val, changed: false };
  const colonMatch = /^(file:\/\/.+?)(:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/i.exec(raw);
  if (colonMatch) {
    const p = normalizeFileUri(colonMatch[1]);
    return { value: `${p.value}${colonMatch[2]}`, changed: true };
  }
  const hashMatch = /^(file:\/\/.+?)#L(\d+)(?:-L?(\d+))?$/i.exec(raw);
  if (hashMatch) {
    const p = normalizeFileUri(hashMatch[1]);
    const start = hashMatch[2];
    const end = hashMatch[3] || start;
    return { value: `${p.value}:${start}-${end}`, changed: true };
  }
  return normalizeFileUri(raw);
}

const WIN_PS_EXPLICIT_RE = /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;
const WIN_PS_DOUBLE_VAR_RE =
  /(?<![\\`])(?:\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE)\b)/i;
// Must stay case-sensitive on cmdlet Verb-Noun (matches upstream mcp-server.mjs:257) so lowercase CLI tokens like `test-runner; echo ok` still route to cmd.exe -> && fix.
const WIN_PS_UNQUOTED_RE =
  /(?<![\\`])\$(?:HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Z][A-Za-z0-9]*\b(?!-)|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/m;

/**
 * Fix upstream N1 on win32: non-PS commands spawn cmd.exe where `;` is literal rather than a separator
 * (so `a.py; b.py` breaks as `a.py;`). Rewrite top-level unquoted `;` cleanly to `&&`, leaving quotes untouched.
 */
export function coerceWindowsCommandSemicolons(command, platform = process.platform) {
  if (platform !== "win32" || typeof command !== "string" || !command.includes(";")) {
    return { value: command, changed: false };
  }
  if (
    WIN_PS_EXPLICIT_RE.test(command) ||
    WIN_PS_DOUBLE_VAR_RE.test(command) ||
    WIN_PS_UNQUOTED_RE.test(command)
  ) {
    return { value: command, changed: false };
  }
  let out = "";
  let quote = null;
  let changed = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if ((ch === "\\" || (quote === '"' && ch === "`")) && i + 1 < command.length) {
        out += ch + command[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ";") {
      changed = true;
      let j = i + 1;
      while (j < command.length && (command[j] === " " || command[j] === "\t" || command[j] === ";")) {
        j++;
      }
      out = out.replace(/[ \t]+$/, "");
      const next = command[j];
      if (j >= command.length || next === "\r" || next === "\n" || next === ")") {
        i = j - 1;
        continue;
      }
      if (/[&|]$/.test(out) || next === "&" || next === "|") {
        if (out && !/\s$/.test(out)) out += " ";
        i = j - 1;
        continue;
      }
      out += " && ";
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return { value: out, changed };
}

const DEFAULT_TOOL_ANNOTATIONS = {
  batch_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_slices: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  quick_outline: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  apply_edits: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run_checks: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

function coerceObjectArrayField(container, key, noteLabel, notes) {
  const val = container[key];
  if (val && !Array.isArray(val) && typeof val === "object") {
    container[key] = [val];
    notes.push(noteLabel);
    return;
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          container[key] = parsed;
          notes.push(noteLabel);
        }
      } catch {
        // leave malformed JSON intact so upstream rejects cleanly
      }
    }
  }
}

function parseRawArgumentsObject(rawArgs) {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return { obj: structuredClone(rawArgs), fromString: false, malformed: false };
  }
  if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { obj: parsed, fromString: true, malformed: false };
      }
    } catch {
      return { obj: null, fromString: true, malformed: true };
    }
    return { obj: null, fromString: true, malformed: true };
  }
  return { obj: {}, fromString: false, malformed: false };
}

export function coerceToolArgs(toolName, rawArgs, options = {}) {
  const strict = options.strict ?? process.env.AGY_FAST_STRICT === "1";
  const allowAutoRange = options.autoRange ?? process.env.AGY_FAST_AUTORANGE !== "0";
  const defaultCwd = options.defaultCwd ?? process.env.AGY_FAST_DEFAULT_CWD;

  const parsedArgState = parseRawArgumentsObject(rawArgs);
  const parsedObj = parsedArgState.obj;
  const requestedMaxChars =
    parsedObj && parsedObj.maxChars !== undefined ? Number(parsedObj.maxChars) : undefined;

  if (strict || parsedArgState.malformed) {
    return { args: rawArgs, notes: [], requestedMaxChars };
  }

  const args = parsedObj;
  const notes = [];

  if (args.cwd === undefined && typeof defaultCwd === "string" && defaultCwd.trim()) {
    args.cwd = path.resolve(defaultCwd.trim());
    notes.push("defaultCwd");
  } else if (typeof args.cwd === "string") {
    const r = normalizeFileUri(args.cwd);
    if (r.changed) {
      args.cwd = r.value;
      notes.push("fileUri->path");
    }
  }

  if (toolName === "quick_outline") {
    if (typeof args.paths === "string") {
      args.paths = parseStringArray(args.paths);
      notes.push("paths->array");
    }
    normalizeFileUriArray(args.paths, notes);
  } else if (toolName === "read_slices") {
    if (typeof args.outlines === "string") {
      args.outlines = parseStringArray(args.outlines);
      notes.push("outlines->array");
    }
    normalizeFileUriArray(args.outlines, notes);
    if (typeof args.lineRanges === "string") {
      args.lineRanges = parseStringArray(args.lineRanges, true);
      notes.push("lineRanges->array");
    }
    if (Array.isArray(args.lineRanges)) {
      let changed = false;
      for (let i = 0; i < args.lineRanges.length; i++) {
        const r = normalizeLineRangeUri(args.lineRanges[i]);
        if (r.changed) {
          args.lineRanges[i] = r.value;
          changed = true;
        }
      }
      if (changed) notes.push("fileUri->path");
    }
    coerceObjectArrayField(args, "slices", "slices->array", notes);
    if (Array.isArray(args.slices)) {
      let changed = false;
      for (const s of args.slices) {
        if (s && typeof s.path === "string") {
          const r = normalizeFileUri(s.path);
          if (r.changed) {
            s.path = r.value;
            changed = true;
          }
        }
      }
      if (changed) notes.push("fileUri->path");
    }
  } else if (toolName === "batch_search") {
    coerceObjectArrayField(args, "queries", "queries->array", notes);
    if (Array.isArray(args.queries)) {
      let changed = false;
      for (const q of args.queries) {
        if (q && typeof q.path === "string") {
          const r = normalizeFileUri(q.path);
          if (r.changed) {
            q.path = r.value;
            changed = true;
          }
        }
      }
      if (changed) notes.push("fileUri->path");
    }
  } else if (toolName === "run_checks") {
    coerceObjectArrayField(args, "commands", "commands->array", notes);
    if (Array.isArray(args.commands)) {
      let uriChanged = false;
      let semiChanged = false;
      for (let i = 0; i < args.commands.length; i++) {
        const c = args.commands[i];
        if (typeof c === "string") {
          const semi = coerceWindowsCommandSemicolons(c);
          if (semi.changed) {
            args.commands[i] = semi.value;
            semiChanged = true;
          }
          continue;
        }
        if (c && typeof c === "object") {
          if (typeof c.cwd === "string") {
            const r = normalizeFileUri(c.cwd);
            if (r.changed) {
              c.cwd = r.value;
              uriChanged = true;
            }
          }
          if (typeof c.command === "string") {
            const semi = coerceWindowsCommandSemicolons(c.command);
            if (semi.changed) {
              c.command = semi.value;
              semiChanged = true;
            }
          }
        }
      }
      if (uriChanged) notes.push("fileUri->path");
      if (semiChanged) notes.push("win32 ';'=>'&&'");
    }
  } else if (toolName === "apply_edits") {
    if (typeof args.verify === "string") {
      const semi = coerceWindowsCommandSemicolons(args.verify);
      if (semi.changed) {
        args.verify = semi.value;
        notes.push("win32 ';'=>'&&'");
      }
    } else if (args.verify && typeof args.verify === "object") {
      if (typeof args.verify.cwd === "string") {
        const r = normalizeFileUri(args.verify.cwd);
        if (r.changed) {
          args.verify.cwd = r.value;
          notes.push("fileUri->path");
        }
      }
      if (typeof args.verify.command === "string") {
        const semi = coerceWindowsCommandSemicolons(args.verify.command);
        if (semi.changed) {
          args.verify.command = semi.value;
          notes.push("win32 ';'=>'&&'");
        }
      }
    }
    coerceObjectArrayField(args, "edits", "edits->array", notes);
    if (Array.isArray(args.edits)) {
      const baseCwd = typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd();
      for (const edit of args.edits) {
        if (!edit || typeof edit !== "object") continue;
        if (typeof edit.path === "string") {
          const r = normalizeFileUri(edit.path);
          if (r.changed) {
            edit.path = r.value;
            notes.push("fileUri->path");
          }
        }
        coerceObjectArrayField(edit, "hunks", "hunks->array", notes);
        if (!Array.isArray(edit.hunks)) continue;

        for (const h of edit.hunks) {
          if (!h || typeof h !== "object") continue;
          const tCandidates = [
            ["target", h.target],
            ["oldText", h.oldText],
            ["old_string", h.old_string],
          ].filter(([, v]) => typeof v === "string");
          if (tCandidates.length > 1 && new Set(tCandidates.map(([, v]) => v)).size > 1) {
            return {
              args: rawArgs,
              notes: [],
              requestedMaxChars,
              validationError: `Conflicting target fields provided (${tCandidates.map(([k]) => k).join(" vs ")}). Pass only 'target'.`,
            };
          }
          if (h.target === undefined) {
            if (typeof h.oldText === "string") {
              h.target = h.oldText;
              delete h.oldText;
              notes.push("oldText->target");
            } else if (typeof h.old_string === "string") {
              h.target = h.old_string;
              delete h.old_string;
              notes.push("old_string->target");
            }
          }

          const rCandidates = [
            ["replacement", h.replacement],
            ["newText", h.newText],
            ["new_string", h.new_string],
          ].filter(([, v]) => typeof v === "string");
          if (rCandidates.length > 1 && new Set(rCandidates.map(([, v]) => v)).size > 1) {
            return {
              args: rawArgs,
              notes: [],
              requestedMaxChars,
              validationError: `Conflicting replacement fields provided (${rCandidates.map(([k]) => k).join(" vs ")}). Pass only 'replacement'.`,
            };
          }
          if (h.replacement === undefined) {
            if (typeof h.newText === "string") {
              h.replacement = h.newText;
              delete h.newText;
              notes.push("newText->replacement");
            } else if (typeof h.new_string === "string") {
              h.replacement = h.new_string;
              delete h.new_string;
              notes.push("new_string->replacement");
            }
          }
        }

        const absPath =
          typeof edit.path === "string" && edit.path
            ? path.isAbsolute(edit.path)
              ? edit.path
              : path.resolve(baseCwd, edit.path)
            : "";

        // Guarded B1 shim: only convert empty-target hunk -> create when parent dir already exists
        // (prevents creating stray nested dirs on typo paths). Not recommended for upstream core PR.
        if (
          edit.create === undefined &&
          absPath &&
          !fs.existsSync(absPath) &&
          fs.existsSync(path.dirname(absPath)) &&
          edit.hunks.length === 1 &&
          (!edit.hunks[0].target || edit.hunks[0].target === "") &&
          typeof edit.hunks[0].replacement === "string"
        ) {
          edit.create = edit.hunks[0].replacement;
          delete edit.hunks;
          notes.push("empty-hunk->create");
          continue;
        }

        // Guarded autoRange: skip replaceAll (range acts as safety fence), skip binary/huge files,
        // and widen ONLY when exactly 1 file-wide match exists.
        if (allowAutoRange && absPath && fs.existsSync(absPath)) {
          try {
            const stat = fs.statSync(absPath);
            if (stat.isFile() && stat.size <= 2 * 1024 * 1024 && !isProbablyBinaryFile(absPath)) {
              const rawContent = fs.readFileSync(absPath, "utf8").replace(/^\uFEFF/, "");
              const normContent = rawContent.replace(/\r\n/g, "\n");
              const lines = normContent.split("\n");
              for (const h of edit.hunks) {
                if (!h || !h.target || h.replaceAll === true) continue;
                if (h.startLine === undefined && h.endLine === undefined) continue;
                const normTarget = h.target.replace(/\r\n/g, "\n");
                const sIdx = Math.max(0, (Number(h.startLine) || 1) - 1);
                const eIdx = Math.min(lines.length, Number(h.endLine) || lines.length);
                const windowText = lines.slice(sIdx, eIdx).join("\n");
                if (!windowText.includes(normTarget)) {
                  const uniqueLine = findUniqueMatchLine(normContent, normTarget);
                  if (uniqueLine !== null) {
                    delete h.startLine;
                    delete h.endLine;
                    notes.push(`autoRange@L${uniqueLine}`);
                  }
                }
              }
            }
          } catch {
            // let upstream handle unreadable/binary files normally
          }
        }
      }
    }
  }

  return { args, notes, requestedMaxChars };
}

export function postProcessToolResult(toolName, result, meta = {}) {
  if (!result || !Array.isArray(result.content)) return result;
  const notes = Array.isArray(meta) ? meta : meta.notes || [];
  const requestedMaxChars = Array.isArray(meta) ? undefined : meta.requestedMaxChars;
  const quiet = (Array.isArray(meta) ? undefined : meta.quiet) ?? process.env.AGY_FAST_QUIET === "1";
  const strict = (Array.isArray(meta) ? undefined : meta.strict) ?? process.env.AGY_FAST_STRICT === "1";

  const cloned = structuredClone(result);
  const firstTextIdx = cloned.content.findIndex((c) => c && c.type === "text" && typeof c.text === "string");
  if (firstTextIdx === -1) return result;

  let text = cloned.content[firstTextIdx].text;
  const isHardError = Boolean(result.isError);
  const isErrorLike = isHardError || (!strict && hasSoftErrorText(text));
  const hasMaxCap = !strict && requestedMaxChars !== undefined && Number.isFinite(requestedMaxChars) && requestedMaxChars > 0;

  if (hasMaxCap && requestedMaxChars < 40) {
    cloned.isError = true;
    cloned.content[firstTextIdx].text = `Error: maxChars (${requestedMaxChars}) is too small (<40); use >=40 to preserve readable output.`;
    return cloned;
  }

  if (isErrorLike) {
    if (
      !strict &&
      toolName === "apply_edits" &&
      text.includes("hunk #2") &&
      text.includes("target text not found") &&
      !text.includes("match the original file in parallel")
    ) {
      const note = "\nNote: multiple hunks in one call match the original file in parallel (cannot chain onto hunk #1's replacement).";
      if (!hasMaxCap || text.length + note.length <= requestedMaxChars) {
        text += note;
      }
    }
    const ex = ONE_LINE_EXAMPLES[toolName];
    if (ex && !text.includes("Example:")) {
      if (!hasMaxCap) {
        text = `${text}\n${ex}`;
      } else if (requestedMaxChars >= ex.length + 40) {
        // Reserve room for Example: by folding the main error body first so total length stays <= requestedMaxChars
        text = `${enforceMaxChars(text, requestedMaxChars - ex.length - 1)}\n${ex}`;
      }
    }
  } else if (!quiet && notes.length > 0) {
    const tag = `[agyfast-universal: ${[...new Set(notes)].join(", ")}]`;
    if (!hasMaxCap || text.length + tag.length + 1 <= requestedMaxChars) {
      text = `${text}\n${tag}`;
    }
  }

  if (hasMaxCap) {
    text = enforceMaxChars(text, requestedMaxChars);
  }

  cloned.content[firstTextIdx].text = text;
  return cloned;
}

function copySchemaAnnotations(src, dst) {
  for (const key of ["description", "title", "default", "examples"]) {
    if (Object.hasOwn(src, key) && src[key] !== undefined) {
      if ((key === "description" || key === "title") && typeof src[key] !== "string") continue;
      dst[key] = structuredClone(src[key]);
    }
  }
}

export function sanitizeJsonSchemaSubset(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return { type: "object", properties: {} };
  }
  const out = {};
  copySchemaAnnotations(node, out);

  if (Array.isArray(node.type) && node.type.length >= 2) {
    out.oneOf = node.type.map((t) => ({ type: String(t) }));
    return out;
  }
  const unionBranches = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : null;
  if (unionBranches && unionBranches.length >= 2) {
    out.oneOf = unionBranches.map((branch) => sanitizeJsonSchemaSubset(branch));
    return out;
  }

  let t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (typeof t !== "string") {
    if (node.properties && typeof node.properties === "object") t = "object";
    else if (node.items !== undefined) t = "array";
  }
  if (typeof t === "string" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(t)) {
    out.type = t;
  } else {
    return out;
  }

  if (t === "object") {
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      const props = {};
      for (const [k, v] of Object.entries(node.properties)) {
        props[k] = sanitizeJsonSchemaSubset(v);
      }
      out.properties = props;
    }
    if (Array.isArray(node.required) && out.properties) {
      const validReq = [...new Set(node.required.filter((k) => typeof k === "string" && Object.hasOwn(out.properties, k)))];
      if (validReq.length > 0) out.required = validReq;
    }
    if (typeof node.additionalProperties === "boolean") {
      out.additionalProperties = node.additionalProperties;
    }
  } else if (t === "array") {
    if (node.items !== undefined && node.items !== null && typeof node.items === "object" && !Array.isArray(node.items)) {
      out.items = sanitizeJsonSchemaSubset(node.items);
    }
  } else {
    const matchesScalar = (val) => {
      if (t === "string") return typeof val === "string";
      if (t === "boolean") return typeof val === "boolean";
      if (t === "null") return val === null;
      if (t === "integer") return typeof val === "number" && Number.isInteger(val);
      return typeof val === "number" && Number.isFinite(val);
    };
    if (Array.isArray(node.enum)) {
      const filtered = node.enum.filter(matchesScalar);
      if (filtered.length > 0) out.enum = filtered;
    }
    if (Object.hasOwn(node, "const") && matchesScalar(node.const)) {
      if (!out.enum || out.enum.includes(node.const)) {
        out.const = node.const;
      }
    }
  }
  return out;
}

export function processToolsListResult(result, options = {}) {
  if (!result || !Array.isArray(result.tools)) return result;
  const dshSchema = options.dshSchema ?? process.env.AGY_FAST_DSH_SCHEMA === "1";
  const annotations = options.annotations ?? process.env.AGY_FAST_ANNOTATIONS === "1";
  const cloned = structuredClone(result);
  cloned.tools = cloned.tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const next = { ...tool };
    if (dshSchema && tool.inputSchema) {
      next.inputSchema = sanitizeJsonSchemaSubset(tool.inputSchema);
      if (tool.name === "apply_edits" && typeof next.description === "string") {
        next.description = next.description.replace(
          "8800 UTF-8 bytes total.",
          "Response <=8800B (input size unrestricted)."
        );
      }
    }
    if (annotations && !tool.annotations && DEFAULT_TOOL_ANNOTATIONS[tool.name]) {
      next.annotations = { ...DEFAULT_TOOL_ANNOTATIONS[tool.name] };
    }
    return next;
  });
  return cloned;
}

export function sanitizeToolsListResult(result) {
  return processToolsListResult(result, { dshSchema: true, annotations: false });
}

export function generateHostContractSnippet(host = "generic") {
  const hostNote =
    host === "antigravity"
      ? "Known ranges/small files (<300 lines): use built-in read_file."
      : host === "claude-code"
        ? "Known ranges/small files (<300 lines): use native Read; keep edits concise."
        : "Known ranges/small files (<200 lines): use native read if available, else read_slices.";
  return [
    START_MARKER,
    "# agy-fast Universal Routing & Contracts",
    "- Batch searches (>=2 queries or git read-only): batch_search",
    "- Large/unknown files (>300 lines): quick_outline first -> targeted read",
    "- Multi-hunk or multi-file edits (+ optional <45s verify): apply_edits",
    "- >=2 independent commands or noisy build/test: run_checks (compact)",
    `- ${hostNote}`,
    "",
    "Parameter contracts (pass arrays/objects, always pass abs cwd):",
    "- batch_search: cwd, queries list of (type: text|regex|glob|fuzzy|git, pattern, path?)",
    "- quick_outline: cwd, paths list",
    "- read_slices: cwd, lineRanges list (e.g. src/a.ts:1-60)",
    "- apply_edits: cwd, edits list of (path, hunks list of (target, replacement, startLine?, replaceAll?) OR create string + overwrite?), bestEffort?, verify?",
    "- run_checks: cwd, commands list of (command, name?), outputMode: compact",
    END_MARKER,
  ].join("\n");
}

/** Marker slicing via indexOf (zero RegExp risk). */
function stripFencedSection(content) {
  let res = content;
  while (true) {
    const start = res.indexOf(START_MARKER);
    if (start === -1) break;
    const end = res.indexOf(END_MARKER, start + START_MARKER.length);
    if (end === -1) break;
    res = res.slice(0, start) + res.slice(end + END_MARKER.length);
  }
  return res.replace(/\n{3,}/g, "\n\n").trim();
}

function upsertFencedBlock(filePath, block, uninstall = false) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const stripped = stripFencedSection(existing);

  if (uninstall) {
    if (!fs.existsSync(filePath)) return { filePath, action: "absent" };
    if (!stripped) {
      fs.unlinkSync(filePath);
      return { filePath, action: "removed-empty-file" };
    }
    fs.writeFileSync(filePath, stripped + "\n", "utf8");
    return { filePath, action: "stripped-block" };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(filePath, next, "utf8");
  return { filePath, action: existing ? "updated" : "created" };
}

function upsertMcpJson(filePath, proxyPath, serverKey = "agy-fast", uninstall = false) {
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      throw new Error(`Refusing to overwrite non-JSON file: ${filePath}`);
    }
  }
  if (!data || typeof data !== "object") data = {};
  if (!data.mcpServers || typeof data.mcpServers !== "object") {
    if (uninstall) return { filePath, action: "absent" };
    data.mcpServers = {};
  }

  if (uninstall) {
    if (!(serverKey in data.mcpServers)) return { filePath, action: "absent" };
    delete data.mcpServers[serverKey];
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    return { filePath, action: "removed-server" };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  data.mcpServers[serverKey] = {
    command: "node",
    args: [proxyPath.replace(/\\/g, "/")],
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { filePath, action: "configured-mcp" };
}

export function runInit({ target = "generic", cwd = process.cwd(), proxyPath, uninstall = false }) {
  const results = [];
  const snippet = generateHostContractSnippet(target);

  if (target === "claude-code" || target === "claude") {
    results.push(upsertFencedBlock(path.join(cwd, "CLAUDE.md"), snippet, uninstall));
    results.push(upsertMcpJson(path.join(cwd, ".mcp.json"), proxyPath, "agy-fast", uninstall));
  } else if (target === "cursor") {
    results.push(upsertFencedBlock(path.join(cwd, ".cursor", "rules", "agy-fast.mdc"), snippet, uninstall));
    results.push(upsertMcpJson(path.join(cwd, ".cursor", "mcp.json"), proxyPath, "agy-fast", uninstall));
  } else {
    results.push(upsertFencedBlock(path.join(cwd, "AGENTS.md"), snippet, uninstall));
    results.push(upsertMcpJson(path.join(cwd, ".mcp.json"), proxyPath, "agy-fast", uninstall));
  }
  return results;
}
