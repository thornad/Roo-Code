# Roo-Code Patches for LM Studio

Custom patches for Roo-Code to improve LM Studio integration.

## Quick Start

**Current working version:** `roo-cline-3.39.3-axios.vsix`

**Installation:**

```bash
code --install-extension source/bin/roo-cline-3.39.3-axios.vsix --force
```

**VSCode Settings:**

```json
{
	"roo-cline.lmStudioBaseUrl": "http://localhost:1234",
	"roo-cline.apiRequestTimeout": 3600
}
```

Restart VSCode and test!

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

## Upgrading to New Versions

### Step 1: Backup Current Build

```bash
mkdir -p backups/v3.36.x
cp source/bin/roo-cline-*.vsix backups/v3.36.x/
cp source/src/api/providers/lm-studio.ts backups/v3.36.x/lm-studio.ts.patched
```

### Step 2: Update Source

```bash
cd source
git stash -m "Local changes before upgrade"
git fetch --tags origin
git checkout v3.XX.X  # Replace with latest tag
```

### Step 3: Apply Patches

```bash
# Apply axios timeout patch
git apply ../axios-timeout.patch

# Apply path trim patch
git apply ../path-trim.patch

# Apply native type safety patch
git apply ../native-type-safety.patch
```

Or use the patch template for lm-studio.ts:

```bash
cp ../lm-studio.ts.axios-patch src/api/providers/lm-studio.ts
```

### Step 4: Build

```bash
pnpm install
pnpm vsix
```

### Step 5: Install

```bash
code --install-extension bin/roo-cline-*.vsix --force
```

---

## Directory Structure

```
roocode/
├── README.md                    <- You are here
├── axios-timeout.patch          <- Timeout + stop execution patch
├── path-trim.patch              <- MiniMax path whitespace fix
├── native-type-safety.patch     <- Native tool call crash fix
├── lm-studio.ts.axios-patch     <- Ready-to-copy patched file
├── lm-studio.ts.axios-backup    <- Original backup
├── patch.sh                     <- Automated patch script
├── HOW-TO-PATCH.md              <- Detailed patching guide
├── QUICK-PATCH.md               <- Quick reference
├── ROOT-CAUSE-ANALYSIS.md       <- Technical deep dive
├── backups/                     <- Previous version backups
│   └── v3.31.x/
└── source/                      <- Roo-Code git repo (v3.39.3)
    ├── src/api/providers/
    │   └── lm-studio.ts         <- Patched file
    └── bin/
        └── roo-cline-3.39.3-axios.vsix
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
