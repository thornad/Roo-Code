# Roo-Code LM Studio

[![GitHub](https://img.shields.io/badge/GitHub-thornad%2FRoo--Code--LM--Studio-blue)](https://github.com/thornad/Roo-Code-LM-Studio)

A fork of [Roo-Code](https://github.com/RooCodeInc/Roo-Code) with patches to fix timeouts and other issues encountered when using it on a local machine - in particular with LM Studio but not limited to it.

## Quick Start

### 1. Download & Install

[![Download Latest Release](https://img.shields.io/github/v/release/thornad/Roo-Code-LM-Studio?label=Download&style=for-the-badge)](https://github.com/thornad/Roo-Code-LM-Studio/releases/latest)

```bash
# Download roo-cline-3.39.3-axios.vsix from the release, then:
code --install-extension roo-cline-3.39.3-axios.vsix --force
```

### 2. Configure VSCode Settings

```json
{
  "roo-cline.lmStudioBaseUrl": "http://localhost:1234",
  "roo-cline.apiRequestTimeout": 3600
}
```

### 3. Restart VSCode

That's it!

---

## Patches Overview

| Patch                        | File                | Purpose                          |
| ---------------------------- | ------------------- | -------------------------------- |
| **axios-timeout.patch**      | `lm-studio.ts`      | Timeout fix + Stop execution     |
| **path-trim.patch**          | Multiple tool files | MiniMax M2.1 path whitespace fix |
| **native-type-safety.patch** | Multiple tool files | Native tool call crash fix       |

---

## Patch Details

### 1. Axios Timeout Patch (`axios-timeout.patch`)

**Problem:** OpenAI SDK uses Node.js fetch/undici with hardcoded 300-second timeout. Long-running LLM operations fail at 301 seconds.

**Solution:** Replace OpenAI SDK with axios HTTP client that respects the `apiRequestTimeout` setting.

**Files Modified:**

- `src/api/providers/lm-studio.ts`

**Features:**

- Configurable timeout via `roo-cline.apiRequestTimeout` setting
- SSE streaming with custom parser
- No more 301-second timeout errors

---

### 2. Stop Execution Fix (included in axios-timeout.patch)

**Problem:** Clicking "Stop" in Roo-Code didn't actually stop the LLM request - it would continue running in the background.

**Solution:** Implemented AbortController to properly cancel HTTP requests.

**Implementation:**

```typescript
// AbortController for request cancellation
private currentAbortController: AbortController | null = null

abort(): void {
    if (this.currentAbortController) {
        this.currentAbortController.abort()
        this.currentAbortController = null
    }
}

// In createMessage():
this.currentAbortController = new AbortController()
axios.get(..., { signal: this.currentAbortController.signal })
```

**Result:** Stop button now immediately cancels the LLM request.

---

### 3. Path Trim Patch (`path-trim.patch`)

**Problem:** MiniMax M2.1 model outputs file paths with extra whitespace (e.g., `" src/file.ts"` instead of `"src/file.ts"`), causing file operations to fail.

**Solution:** Trim whitespace from file paths in all tool parsers.

**Files Modified:**

- `src/core/assistant-message/NativeToolCallParser.ts`
- `src/core/tools/ApplyDiffTool.ts`
- `src/core/tools/EditFileTool.ts`
- `src/core/tools/ListFilesTool.ts`
- `src/core/tools/ReadFileTool.ts`
- `src/core/tools/SearchFilesTool.ts`
- `src/core/tools/WriteFileTool.ts`
- And others...

**Example fix:**

```typescript
// Before:
const entry: FileEntry = { path: file.path }

// After:
const entry: FileEntry = { path: typeof file.path === "string" ? file.path.trim() : file.path }
```

---

### 4. Native Type Safety Patch (`native-type-safety.patch`)

**Problem:** Native tool calls (used by LM Studio, Ollama, etc.) bypass the `parseLegacy()` method and send parameters directly to `execute()`. If a model sends malformed data where `path` or `content` are undefined/null/non-string, methods like `.startsWith()` or `.trim()` crash with `TypeError: h.startsWith is not a function`.

**Solution:** Add defensive type checking in `execute()` methods to handle malformed native tool call parameters.

**Files Modified:**

- `src/core/tools/WriteToFileTool.ts`
- `src/core/tools/ReadFileTool.ts`
- `src/core/tools/EditFileTool.ts`
- `src/core/tools/ApplyDiffTool.ts`

**Example fix:**

````typescript
// Before (crashes if params.content is undefined):
const relPath = params.path
let newContent = params.content
if (newContent.startsWith("```")) { ... }  // TypeError!

// After (safe):
const relPath = typeof params.path === "string" ? params.path.trim() : ""
let newContent = typeof params.content === "string" ? params.content : ""
if (newContent.startsWith("```")) { ... }  // Works
````

**Root Cause:** This is an existing bug in Roo Code's native tool call handling, not introduced by our patches. It surfaces when using LM Studio with native tool protocol because models may send incomplete or malformed parameter data.

---

## Upgrading to New Upstream Versions

### Step 1: Fetch upstream changes

```bash
git fetch origin  # origin = RooCodeInc/Roo-Code
git merge origin/main
# Resolve any conflicts in patched files
```

### Step 2: Build

```bash
pnpm install
pnpm vsix
```

### Step 3: Install

```bash
code --install-extension bin/roo-cline-*.vsix --force
```

---

## Repository Structure

```
Roo-Code-LM-Studio/
├── README.md                    <- You are here
├── src/
│   ├── api/providers/
│   │   └── lm-studio.ts         <- Patched: axios timeout + stop execution
│   └── core/tools/
│       ├── ApplyDiffTool.ts     <- Patched: type safety
│       ├── EditFileTool.ts      <- Patched: type safety
│       ├── ReadFileTool.ts      <- Patched: type safety + path trim
│       └── WriteToFileTool.ts   <- Patched: type safety
└── bin/
    └── roo-cline-3.39.3-axios.vsix  <- Pre-built extension
```

---

## Version History

| Version           | Date       | Patches Applied                                |
| ----------------- | ---------- | ---------------------------------------------- |
| 3.39.3-axios      | 2025-01-12 | axios-timeout + path-trim + native-type-safety |
| 3.36.16-axios     | 2024-12-20 | axios-timeout + path-trim                      |
| 3.36.12           | 2024-12-18 | axios-timeout                                  |
| 3.36.0            | 2024-12-04 | axios-timeout                                  |
| 3.34.8            | 2024-12-01 | axios-timeout                                  |
| 3.34.7-axios      | 2024-11-27 | axios-timeout                                  |
| 3.31.5-dispatcher | 2024-11-10 | Alternative dispatcher approach                |
| 3.31.4-axios      | 2024-11-10 | Initial axios patch                            |

---

## Testing

Confirmed working with:

- Node.js v22+
- LM Studio 0.3.x
- Large PDF files (6.7MB+)
- Processing times >30 minutes
- Stop execution works immediately
- MiniMax M2.1 file operations work correctly

---

**Status:** Production Ready
**Last Updated:** 2025-01-12
**Upstream:** [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code)
**Fork:** [thornad/Roo-Code-LM-Studio](https://github.com/thornad/Roo-Code-LM-Studio)
