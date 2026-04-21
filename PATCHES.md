# Patches (Ruben's fork)

Personal divergences from upstream `s-hiraoku/vscode-sidebar-terminal`. Each entry says **what the user sees** and where the code lives — not how it works internally. For the technical detail, follow the links and read the `Patch (ruben)` comments in the source.

If you're adding a new patch: append a section here, keep it user-facing, and tag the code with `// Patch (ruben):` so it's greppable.

---

## How to build & install (this fork)

```sh
npm install                                         # once
npm run package                                     # webpack production build
npx @vscode/vsce package --target darwin-arm64      # or whichever target
cursor --install-extension ./<file>.vsix --force    # Cursor
# code  --install-extension ./<file>.vsix --force   # VS Code
```

After installing, **reload the window** (Cmd+Shift+P → "Developer: Reload Window").

Platform targets available as npm scripts: `vsce:package:darwin-arm64`, `...:darwin-x64`, `...:linux-x64`, `...:linux-arm64`, `...:win32-x64`, `...:win32-arm64`.

## How to publish a build so others can grab it

`.vsix` files are gitignored — distribute them via GitHub Releases:

```sh
# 1. Bump package.json -> "version": "0.6.3-ruben.N+1", commit, push.
# 2. Build the .vsix for the platform(s) you want to support.
# 3. gh release create v0.6.3-ruben.N+1 *.vsix \
#       --title "v0.6.3-ruben.N+1" \
#       --notes "short changelog"
```

Consumers install with `cursor --install-extension ~/Downloads/<file>.vsix --force` and reload.

---

## Terminal link detection — what you get

Upstream only underlines paths on hover, with hardcoded expectations about what a path looks like. This fork makes link handling more forgiving.

### 1. Links are coloured as soon as they appear, not on hover

Paths light up in a distinctive blue the moment a tool prints them. You no longer need to hover to see that something is clickable.

- Code: [`src/webview/managers/TerminalLinkManager.ts`](./src/webview/managers/TerminalLinkManager.ts) — `_startProactiveScan` + `_ensureLinkDecoration`
- Trigger: xterm `onRender` — scans the exact row range that just changed, so it works with animated TUIs (Claude Code, Codex etc.) that move the cursor around instead of emitting clean newlines.

### 2. Wider set of path shapes are recognised

All of these now become clickable:

| Shape              | Example                                 |
| ------------------ | --------------------------------------- |
| Absolute           | `/Users/ruben/foo.ts:42`                |
| Explicit relative  | `./foo.ts`, `../bar.ts`                 |
| Workspace-relative | `src/app.ts:42`, `.claude/rules/foo.md` |
| **Home-relative**  | `~/.config/fish/config.fish`            |
| Windows            | `C:\path\to\file.ts`                    |
| GitHub fragment    | `foo.ts#L42-L50`                        |
| Colon range        | `foo.ts:42-50`, `foo.ts:42:5-50:10`     |

- Code: [`src/webview/managers/TerminalLinkManager.ts`](./src/webview/managers/TerminalLinkManager.ts) — the two regexes at top of class + `parseFileLink`.

### 3. Paths that span two rows still work

Long paths wrapped across two terminal rows (soft- or hard-wrapped) are stitched back together and treated as one link. Upstream matched each row in isolation and either missed the whole thing or produced two broken half-links.

- Code: same file — `stitchWrappedLogicalLine` + `_looksHardWrapped`.

### 4. Links open even when the path doesn't exist where you'd expect

If the direct lookup fails (terminal CWD, workspace folder, process CWD), the resolver falls back to **suffix matching**: it looks for any file in the workspace whose path ends with the requested path, respecting `.gitignore`. One match → opens it. Multiple matches → you get a quick-pick.

Why this matters: tools like Claude Code print paths relative to wherever _they_ were launched, which isn't always the VS Code workspace root. Without this, those paths silently fail to resolve.

- Code: [`src/providers/services/TerminalLinkResolver.ts`](./src/providers/services/TerminalLinkResolver.ts) — `resolveViaSuffixMatch`.
- Uses `vscode.workspace.findFiles` under the hood (VS Code's built-in ripgrep index).

### 5. Line ranges open as selections, not just cursors

Clicking `foo.ts:42-50` opens `foo.ts` with lines 42–50 actually selected. Same for `foo.ts:42:5-50:10` and `foo.ts#L42-L50`.

- Code: `TerminalLinkResolver._handleFileLink` — the `endLineNumber` / `endColumnNumber` branch.

### 6. `file://` URLs open in the editor

Dropping a `file:///...` URL opens it in VS Code instead of kicking it out to Finder. Line/column fragments (both `:42:5` and `#L42C5`) work.

- Code: `TerminalLinkResolver._handleUrlLink` + `_parseFileUrl`.

---

## Adding a new patch

1. Tag the code: `// Patch (ruben): one-line reason`.
2. Add a short user-facing section here with a link to the code.
3. If it's a behaviour change worth knowing about at a glance, bump the changelog in `package.json` (`version: 0.6.3-ruben.N`) so we can tell builds apart.
