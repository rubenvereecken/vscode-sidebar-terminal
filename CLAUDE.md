# CLAUDE.md

Orientation for future Claude Code sessions. Terse by design — follow links for detail.

## This is a fork

Personal fork of [`s-hiraoku/vscode-sidebar-terminal`](https://github.com/s-hiraoku/vscode-sidebar-terminal). Every fork-local change lives in [`PATCHES.md`](./PATCHES.md) — **read that for what's different and why.** Don't re-explain patches here; point at code instead.

Remotes:

- `origin` → this fork (push here)
- `s-hiraoku` → upstream (pull only)

Versions are `0.6.3-ruben.N`. Bump `N` for any change that needs a distinguishable rebuild.

## Where fork code lives

Grep `// Patch (ruben):` to find every fork-local edit. Hot spots:

- [`src/webview/managers/TerminalLinkManager.ts`](./src/webview/managers/TerminalLinkManager.ts) — link detection, wrap-stitching, proactive colouring
- [`src/providers/services/TerminalLinkResolver.ts`](./src/providers/services/TerminalLinkResolver.ts) — file resolution, suffix-match fallback
- [`src/test/vitest/unit/providers/services/TerminalLinkResolver.test.ts`](./src/test/vitest/unit/providers/services/TerminalLinkResolver.test.ts) — resolver tests

`src/test/vitest/unit/webview/managers/TerminalLinkManager.test.ts` has pre-existing upstream failures (mock `buffer.length` missing). Leave them alone unless asked.

## Build & install locally

```sh
npm install                                         # once
npm run package                                     # webpack production
npx @vscode/vsce package --target darwin-arm64      # build .vsix (pick your platform)
cursor --install-extension ./<file>.vsix --force    # or `code --install-extension`
```

Then reload the window (Cmd+Shift+P → "Developer: Reload Window"). Other platforms: `package.json` → `vsce:package:*`.

## Publish a build for others

`.vsix` is gitignored. Distribute via GitHub Releases:

```sh
# bump package.json version, commit, push, then:
gh release create v0.6.3-ruben.N \
  vscode-sidebar-terminal-darwin-arm64-0.6.3-ruben.N.vsix \
  --title "v0.6.3-ruben.N" \
  --notes "short changelog"
```

Consumers install with `cursor --install-extension <file>.vsix --force` and reload.

## Syncing with upstream

```sh
git fetch s-hiraoku
git merge s-hiraoku/main    # prefer merge to preserve the ruben.N lineage
```

When upstream bumps base (`0.6.3` → `0.6.4`), carry the suffix: `0.6.4-ruben.1`.

## House rules

- Tag every fork-local change with `// Patch (ruben):` + one-line reason. Grep-discoverable.
- Every behaviour change gets a PATCHES.md section. User-facing language, not implementation.
- Don't edit upstream files without a patch tag. If it's not in PATCHES.md, it shouldn't be in the diff.
- **CLAUDE.md has git-safety reflexes:** use `git stash` before investigations; never `git checkout -- .`, `git restore .`, or `git clean` without explicit confirmation.

## Subproject docs (from upstream, still accurate)

| File                    | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `src/webview/CLAUDE.md` | WebView architecture, Manager patterns, debugging |
| `src/test/CLAUDE.md`    | TDD workflow, test patterns                       |

Commands worth knowing: `npm run compile`, `npm run watch`, `npm run test:unit`, `npm run lint`, `npm run format`. Release-automation docs from upstream are in git history if you ever need them — this fork doesn't use them; we build and publish via the section above.

<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:

- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->
