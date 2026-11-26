# `agyfast-universal` — 零依赖跨宿主 MCP 透明代理与 PR 工程边界

在不改动官方 `agy-fast` 插件产物的前提下，提供一个极轻、零运行期依赖的 Stdio MCP 透明转发层与跨 Agent 契约分发器。

## 1. 本地运行与环境变量开关

- **作为 MCP Server 挂载**：`node proxy.mjs`
- **体检与预算门禁**：`node proxy.mjs doctor`
- **跨宿主一键配置 / 无痕卸载**：`node proxy.mjs init --target <claude-code|cursor|opencode|generic> [--cwd <dir>] [--uninstall]`
- **安全可逆开关**：
  - `AGY_FAST_STRICT=1`：一键退回严格原版透传（关闭一切边界纠偏与软错误补全）。
  - `AGY_FAST_QUIET=1`：关闭纠偏成功时末尾的 `[agyfast-universal: ...]` 提示，仅保留错误示例。
  - `AGY_FAST_AUTORANGE=0`：禁用 `startLine` 唯一匹配弹性放宽。
  - `AGY_FAST_DSH_SCHEMA=1`：按 DSH `json-schema.ts` 受控子集动态裁剪 `tools/list` 中不支持的约束键（如 `minimum`/`maximum`/`minItems`/`maxItems`，并将 `anyOf` 转为 `oneOf`），避免 DSH PTC 模式将工具签名退化成 `unknown`（零工具硬编码，兼容上游后续升级）。
  - `AGY_FAST_DEFAULT_CWD=<dir>`：当外部宿主既无 `roots/list` 也未在入参传 `cwd` 时，显式回退到指定默认工作区（不猜测默认目录，未设置时不生效）。
  - `AGY_FAST_ANNOTATIONS=1`：按需在 `tools/list` 为已知只读/编辑/命令工具附加标准 MCP `annotations`（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`），默认关闭以严格维持 `<=1280 B` 工具声明红线；此外默认自动将 `file://...`（含 `#L1-L2` 锚点）转为本地文件系统路径。
  - `AGY_FAST_USAGE=1` / `AGY_FAST_USAGE_LOG=<路径>`：显式开启 JSONL 调用统计（记录 `{ t, tool, ms, isError, sessionPid, host, version }`；默认不写盘以免污染只读或公开仓库目录；设 `AGY_FAST_USAGE=0` 可强制关闭）；同时在非 `AGY_FAST_STRICT=1` 模式下于 `initialize.result.serverInfo.agyfast` 注入代理/适配器/上游文件版本指纹。
  - `--tools <list>` / `AGY_FAST_TOOLS`：按逗号分隔裁剪暴露给宿主的 MCP 工具子集，对未暴露工具返回 `-32602`（同时兼容现有 `v0.3.1` 上游）。
  - **Windows 默认防坑（非严格模式自动启用）**：① 在 `run_checks` / `apply_edits.verify` 自动将非 PowerShell 命令外层的 `;` 归一化为 `&&`（保留引号内 `;`，避免 `cmd.exe` 将 `;` 拼进文件名引发 N1）；② 未显式指定 `PYTHONIOENCODING` 时注入 `PYTHONIOENCODING=utf-8`，避免打印 `−`（U+2212）或中文触发 Python GBK `UnicodeEncodeError`；③ `apply_edits` 的 `create`/编辑入参无 8.8 KB 上限（`8800B` 仅限制返回文本体积），在 `AGY_FAST_DSH_SCHEMA=1` 下已重写描述避免误拆写入。

## 2. 给上游提 PR 时的工程边界拆分（重要）

本地代理可以为了外挂宿主便利多走半步，但**向 `INK-Q/agy-fast` 上游提 PR 时必须严格区分以下两部分**：

### A. 适合直接提 PR 合入上游核心（0 副作用、纯正收益）
1. **智能错误引导层（P1 + P3）**：
   - 对未置 `isError` 的软错误文本（`ERROR:`、`## [FAIL` 等）同样附带 1 行最小合法 JSON `Example:`；
   - `hunk` 缺 `target` 时显式提示新建请用 `create`；
   - `hunk #2` 失配时提示多 `hunk` 对原文并行匹配（非链式）。
2. **零 Schema 增量边界归一化**：
   - `paths` / `lineRanges` 单字符串自动包数组；
   - `oldText`/`newText` 别名静默映射（通过 `strict` 可关）。
3. **`maxChars` 语义对齐与安全头尾折叠**：
   - 将工具描述中的实际下限与校验逻辑对齐，避免模型误传 `<500` 时产生预期落差；超出上限时采用 UTF-16 代理对安全的 Head-Tail 折叠。
4. **CI 防臃肿预算门禁**：
   - 自动检验 `runtimeDeps === 0`、单工具 `Schema <= 1280 B`、包体积增量与冷启动上限。

### B. 仅保留在本地代理层（不建议作为上游默认行为强推）
1. **`empty-hunk -> create` 猜测建文件**：存在路径拼写失误制造幽灵文件的风险（本地代理已限制仅当父目录已存在时才允许转换；上游 PR 应坚持“报错并用一句话引导改用 `create`”）。
2. **隐式 `autoRange` 越过用户声明的 `startLine`/`endLine`**：虽对局部唯一锚点友好，但可能违背“区间保护”预期（本地代理已对 `replaceAll: true` 严格禁放宽；上游 PR 若引入应作为显式 `autoRange?: boolean` 选项，而非默认静默放宽）。

## 3. 功能冻结与退场矩阵（Retirement Matrix）

- **冻结原则**：不再新增参数重写或花哨包装；`node proxy.mjs doctor` 强制校验 `wrapperBytes <= 51200`（50 KB 上限），后续只随上游合入做减法。
- **永久薄差异层（上游明确不进核心的宿主便利/可观测性）**：
  - `AGY_FAST_DEFAULT_CWD`（无 `roots/list` 宿主的工作区兜底）
  - `AGY_FAST_USAGE_LOG`（显式开启时的本地调用日志，含 `host`/`version` 归因）
  - `AGY_FAST_ANNOTATIONS=1`、`file://` URI 解包、`autoRange`、`empty-hunk -> create` 与软错误 `Example:` 引导
- **已合入或待发版即刻退场（等 `v0.3.2` 更新到本机插件后删减）**：
  - `AGY_FAST_DSH_SCHEMA=1`（`sanitizeJsonSchemaSubset`）→ 上游已在 `dev`（`f35ba50`）原生落地 `--schema-compat=minimal` / `AGY_FAST_SCHEMA_COMPAT=minimal`；`v0.3.2` 后改为透传官方 `--schema-compat=minimal` 并删除本地重写逻辑；
  - `--tools` 本地代理拦截 → 上游 `INK-Q/agy-fast#64` 合入并发布 `v0.3.2` 后改为透传；
  - 入参单串/别名容错与硬校验 `Example:` 引导 → 上游 `INK-Q/agy-fast#77` 合入并发布 `v0.3.2` 后删除；
  - Windows 非 PowerShell 命令 `;` → `&&` 归一化 → 上游 `INK-Q/agy-fast#82` 已合入 `dev`，发布 `v0.3.2` 后评估删除；
  - `apply_edits` 工具描述 `8800B` 语义澄清 → 待上游同步澄清“仅限返回、不限输入”后删除。

## 4. 致谢与免责声明

- **上游致谢**：核心搜检、大纲、切片与原子写能力全部来自 [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast)（MIT）。本仓库仅提供零修改上游产物、零运行期依赖的外围 Stdio 协议适配层；默认自动定位 `~/.gemini/config/plugins/agy-fast/dist/mcp-server.mjs`，也可通过 `AGY_FAST_UPSTREAM` 指定路径。
- **免责声明**：本工具为个人实验与学习型工程辅助脚本，按原样（`AS-IS`）提供（MIT License），不作任何生产稳定性或跨环境兼容性保证；如有需要请备份代码或设置 `AGY_FAST_STRICT=1` 秒切回原版透传。
