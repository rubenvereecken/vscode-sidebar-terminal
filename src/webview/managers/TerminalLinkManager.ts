/**
 * Terminal Link Manager
 *
 * Handles file path and URL link detection in terminal output.
 * Follows VS Code standard terminal link behavior:
 * - Links require modifier key + click to activate (Cmd/Ctrl or Alt depending on settings)
 * - Hover shows underline and pointer cursor when modifier key is pressed
 * - Supports file paths with line:column navigation
 */

import { Terminal, type ILink, type IDisposable } from '@xterm/xterm';
import { IManagerCoordinator } from '../interfaces/ManagerInterfaces';
import { terminalLogger } from '../utils/ManagerLogger';
import { BaseManager } from './BaseManager';

/**
 * Parsed file link with optional line/column and optional range end.
 *
 * Patch (ruben): added endLine/endColumn so we can highlight a selection
 * instead of a single caret. Formats we parse:
 *   path                    -> {path}
 *   path:42                 -> {path, line}
 *   path:42:5               -> {path, line, column}
 *   path:42-50              -> {path, line, endLine}
 *   path:42:5-50            -> {path, line, column, endLine}
 *   path:42:5-50:10         -> {path, line, column, endLine, endColumn}
 */
interface ParsedFileLink {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Terminal Link Manager
 *
 * Detects clickable file paths in terminal output and opens them in the editor.
 * URL links are handled separately by WebLinksAddon.
 *
 * VS Code Standard Behavior:
 * - When multiCursorModifier is 'alt', Cmd/Ctrl+Click opens links
 * - When multiCursorModifier is 'ctrlCmd', Alt+Click opens links
 * - Hover shows underline when modifier key is pressed
 */
export class TerminalLinkManager extends BaseManager {
  private readonly coordinator: IManagerCoordinator;
  private readonly linkProviderDisposables = new Map<string, IDisposable>();

  // Current link modifier setting (updated when settings change)
  // 'alt' means Alt is for multi-cursor, so Cmd/Ctrl opens links
  // 'ctrlCmd' means Cmd/Ctrl is for multi-cursor, so Alt opens links
  private linkModifier: 'alt' | 'ctrlCmd' = 'alt';

  // Patch (ruben): two regexes, run in sequence, results merged.
  //
  // absoluteOrExplicitRelativeRegex matches paths that are unambiguously
  // paths because of their leading prefix: /abs, ./rel, ../rel, C:\win.
  // The negative lookbehind is the critical bit: without it the regex
  // happily matches "/server/app.ts" in the MIDDLE of "app/server/app.ts",
  // stealing the match from the implicit-relative regex and producing a
  // broken short absolute link. The lookbehind forbids a path-like char
  // immediately before the prefix — the emitter-side boundary.
  //
  // implicitRelativeRegex matches workspace-relative paths without a
  // leading slash (e.g. "app/server/app.ts:42", ".claude/rules/foo.md").
  // False positives are the risk here, so we require BOTH a path separator
  // AND a dotted extension of 1-6 word chars. Leading `.` is allowed so
  // dotfiles like .claude, .vscode, .github match too.
  private readonly absoluteOrExplicitRelativeRegex =
    /(?<![\w.\-/\\])(?:\.{0,2}\/|[A-Za-z]:\\)[^\s"'<>()[\]{}|]+/g;
  // Patch (ruben): the trailing `(?:colon-style|hash-style)?` group lets
  // the implicit regex capture the line/range suffix in either format:
  //   colon: foo.ts:42, foo.ts:42:5, foo.ts:42-50, foo.ts:42:5-50:10
  //   hash:  foo.ts#L42, foo.ts#L42-L175, foo.ts#L42C5-L175C10
  // Without the hash branch, group 1 stopped at the `.ts` extension and
  // the line range was silently lost. Claude Code emits hash-style.
  private readonly implicitRelativeRegex =
    /(?:^|[\s"'`(\[{])(\.?[\w][\w.\-]*\/[\w.\-/]*\.[\w]{1,6}(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?)?)/g;

  // Characters that can plausibly appear in a file path. Used by the
  // hard-wrap heuristic below to decide whether to stitch adjacent rows.
  private static readonly PATH_CHAR_RE = /[A-Za-z0-9_\-./\\]/;

  // Patch (ruben): the prev row "looks complete" — it ends with a dotted
  // extension followed by optional non-word punctuation. That's the signal
  // for "this is a fully-formed file ref, NOT a wrap candidate". E.g.
  //   "...interactive_server.py."  →  ".py."   matches  →  don't stitch
  //   "...interactive_server.py:42"  →  doesn't match (digits after :)
  //   "...20tech"                  →  no `.`   doesn't match  →  may stitch
  private static readonly COMPLETE_PATH_TAIL_RE = /\.[A-Za-z0-9]{1,6}[^\w]*$/;

  // Patch (ruben): the prev row's tail must look like a path fragment —
  // a `/` (or `\`) followed by zero or more path chars to end. Excludes
  // English words that just happen to end with a path-like character.
  private static readonly PATH_FRAGMENT_TAIL_RE = /[/\\][\w\-.]*$/;

  // Patch (ruben): diagnostic log flag. Set to true to dump stitcher
  // behaviour to the webview console — invaluable for figuring out why a
  // particular long path isn't getting matched. Off by default because
  // provideLinks fires on hover for every visible row.
  private static readonly DIAGNOSE_STITCH = false;

  private static _diag(message: string, ...args: unknown[]): void {
    if (TerminalLinkManager.DIAGNOSE_STITCH) {
      // eslint-disable-next-line no-console
      console.log(`[LINK-STITCH] ${message}`, ...args);
    }
  }

  constructor(coordinator: IManagerCoordinator) {
    super('TerminalLinkManager', {
      enableLogging: false,
      enablePerformanceTracking: true,
      enableErrorRecovery: true,
    });
    this.coordinator = coordinator;
  }

  /**
   * Update link modifier setting
   * Called when VS Code settings change
   */
  public setLinkModifier(modifier: 'alt' | 'ctrlCmd'): void {
    this.linkModifier = modifier;
    terminalLogger.info(`Link modifier updated to: ${modifier}`);
  }

  /**
   * Check if the event has the required modifier key for link activation
   * VS Code uses the OPPOSITE modifier for links:
   * - When multiCursorModifier is 'alt', Cmd/Ctrl+Click opens links
   * - When multiCursorModifier is 'ctrlCmd', Alt+Click opens links
   */
  private isValidLinkActivation(event: MouseEvent | undefined): boolean {
    if (!event) return false;

    if (this.linkModifier === 'alt') {
      // Alt is for multi-cursor, so Cmd/Ctrl opens links
      return event.metaKey || event.ctrlKey;
    } else {
      // Cmd/Ctrl is for multi-cursor, so Alt opens links
      return event.altKey;
    }
  }

  protected doInitialize(): void {
    terminalLogger.info('TerminalLinkManager initialized');
  }

  /**
   * Register link provider for a terminal
   */
  public registerTerminalLinkHandlers(terminal: Terminal, terminalId: string): void {
    try {
      // Dispose existing provider if any
      this.linkProviderDisposables.get(terminalId)?.dispose();

      const disposable = terminal.registerLinkProvider({
        provideLinks: (lineNumber, callback) => {
          const links = this.findLinksInLine(terminal, lineNumber, terminalId);
          callback(links);
        },
      });

      this.linkProviderDisposables.set(terminalId, disposable);
      terminalLogger.debug(`Link provider registered for ${terminalId}`);
    } catch (error) {
      terminalLogger.warn(`Failed to register link provider for ${terminalId}:`, error);
    }
  }

  /**
   * Find all file links in a terminal line.
   *
   * Patch (ruben): when a logical line wraps across multiple buffer rows
   * (happens for long absolute paths in a narrow sidebar), the original
   * implementation called translateToString per row and ran the regex
   * against each row in isolation. A path like
   *     /Users/ruben/20tech/drivingtest/app/server/app.ts:42
   * wrapped between `app` and `/server/...` would then be matched as two
   * separate "links":
   *   - /Users/ruben/20tech/drivingtest/app  (a directory — stat fails, silent)
   *   - /server/app.ts:42                    (treated as absolute — fails)
   *   or, if cwd was right, resolvable via terminal cwd but visually the
   *   highlight only lit up on the second row, which is the "it's the slash"
   *   symptom.
   *
   * Fix: walk backwards while the current line is a continuation (isWrapped)
   * to find the logical line's start, then forward stitching rows together
   * into one string while remembering where each character came from. Run
   * the regex on the stitched string and emit ILink ranges that span both
   * rows so xterm underlines the whole path.
   */
  private findLinksInLine(terminal: Terminal, lineNumber: number, terminalId: string): ILink[] {
    try {
      const stitched = this.stitchWrappedLogicalLine(terminal, lineNumber);
      if (!stitched) return [];
      return this.extractFileLinksFromStitched(stitched, terminalId);
    } catch (error) {
      terminalLogger.warn('Error finding links:', error);
      return [];
    }
  }

  /**
   * Walk the buffer around `lineNumber` to assemble the full logical line it
   * belongs to and build a parallel offset→(x,y) map so regex matches in
   * the stitched string can be translated back to xterm buffer coordinates.
   *
   * Two kinds of "continuation" are recognised:
   *   1. Soft wraps — xterm sets `line.isWrapped = true` on the continuation
   *      row. Canonical and authoritative.
   *   2. Hard wraps — the emitter inserted a literal newline mid-path (e.g.
   *      Claude Code pre-wrapping its markdown output to its own idea of
   *      the terminal width). xterm has no metadata for these, so we use
   *      a content heuristic: the previous row fills the terminal width,
   *      its last char is path-like, and the current row starts path-like.
   *
   * xterm uses 1-indexed rows and columns in ILink.range.
   */
  private stitchWrappedLogicalLine(
    terminal: Terminal,
    lineNumber: number
  ): { text: string; positions: Array<{ x: number; y: number }> } | null {
    const buffer = terminal.buffer.active;
    const cols = terminal.cols;
    const zeroIdx = lineNumber - 1;

    // Gate diagnostics on the current row containing a `/` — limits noise
    // to rows that might actually have a path in them.
    const entryLine = buffer.getLine(zeroIdx);
    const entryText = entryLine?.translateToString(true) ?? '';
    const diag = TerminalLinkManager.DIAGNOSE_STITCH && entryText.includes('/');

    // Find the first row of the logical line by walking upward as long as
    // each row we look at is a continuation of the row above it.
    let startZero = zeroIdx;
    while (startZero > 0) {
      const here = buffer.getLine(startZero);
      if (!here) break;

      if (here.isWrapped) {
        if (diag) TerminalLinkManager._diag(`walk up: row ${startZero + 1} isWrapped=true`);
        startZero--;
        continue;
      }

      const prev = buffer.getLine(startZero - 1);
      const wrap = this._looksHardWrapped(prev, here, cols);
      if (diag) {
        const prevT = prev?.translateToString(true) ?? '';
        const hereT = here.translateToString(true);
        TerminalLinkManager._diag(
          `walk up: row ${startZero + 1}, prev len=${prevT.length} last=${JSON.stringify(prevT.slice(-8))}, here first=${JSON.stringify(hereT.slice(0, 10))}, hardWrap=${wrap ? `indent=${wrap.indent}` : 'no'}`
        );
      }
      if (wrap) {
        startZero--;
        continue;
      }

      break;
    }

    const text: string[] = [];
    const positions: Array<{ x: number; y: number }> = [];

    // Collect this logical line forward from the start. Stop as soon as we
    // pass the starting row AND the next row isn't a continuation of the
    // previous one. For continuation rows we skip the indent so the
    // stitched text doesn't have a gap (regex would break on whitespace).
    let cursor = startZero;
    while (cursor < buffer.length) {
      const row = buffer.getLine(cursor);
      if (!row) break;

      let indentSkip = 0;
      if (cursor > startZero) {
        const softWrap = row.isWrapped;
        let isContinuation = softWrap;
        if (!softWrap) {
          const wrap = this._looksHardWrapped(buffer.getLine(cursor - 1), row, cols);
          if (diag) {
            const prev = buffer.getLine(cursor - 1);
            const prevT = prev?.translateToString(true) ?? '';
            const hereT = row.translateToString(true);
            TerminalLinkManager._diag(
              `walk fwd: row ${cursor + 1}, prev len=${prevT.length} last=${JSON.stringify(prevT.slice(-8))}, here first=${JSON.stringify(hereT.slice(0, 10))}, hardWrap=${wrap ? `indent=${wrap.indent}` : 'no'}`
            );
          }
          if (wrap) {
            isContinuation = true;
            indentSkip = wrap.indent;
          }
        }
        if (!isContinuation) break;
      }

      const rowText = row.translateToString(true);
      for (let col = indentSkip; col < rowText.length; col++) {
        text.push(rowText[col]!);
        positions.push({ x: col + 1, y: cursor + 1 });
      }
      cursor++;
    }

    if (text.length === 0) return null;

    const stitched = text.join('');
    if (diag && cursor - startZero > 1) {
      TerminalLinkManager._diag(
        `STITCHED rows ${startZero + 1}..${cursor}: ${JSON.stringify(stitched)}`
      );
    }
    return { text: stitched, positions };
  }

  /**
   * Heuristic for hard-wrapped text: does `here` look like a continuation
   * of `prev`? Returns the indent count to skip on `here` if yes, null
   * otherwise.
   *
   * Patch (ruben, round 3): rebuilt after live diagnostic feedback. The
   * round-2 version checked literal first/last char path-likeness. That
   * misfired on two cases:
   *
   *   1. Markdown numbered-list wrap continuations are INDENTED to align
   *      with the bullet content. So `here.charAt(0)` was `' '`, not the
   *      path char two spaces later.
   *   2. Two adjacent unrelated list items both happened to satisfy the
   *      path-char check at their boundary (e.g. prev ends `.py.`, next
   *      starts `5. `), and got stitched into nonsense.
   *
   * Round-3 conditions, all required:
   *
   *   a. prev does NOT look like a complete file reference (no dotted
   *      extension at the end, optionally followed by punctuation). This
   *      is the "py.\n5." escape valve.
   *   b. prev's tail looks like an in-flight path fragment — ends in `/`
   *      or `\` followed by zero or more path chars to EOL. Bare English
   *      words are rejected here.
   *   c. here, after stripping leading whitespace, has a first word that
   *      looks path-shaped: contains a `/` or a dotted extension.
   *
   * Returns { indent } so the caller can skip those leading chars when
   * stitching. The cols parameter is unused but kept for future tuning.
   */
  private _looksHardWrapped(
    prev: { translateToString(trimRight: boolean): string } | undefined,
    here: { translateToString(trimRight: boolean): string },
    _cols: number
  ): { indent: number } | null {
    if (!prev) return null;

    const prevText = prev.translateToString(true);
    if (prevText.length === 0) return null;

    // (a) bail if prev tail looks complete
    if (TerminalLinkManager.COMPLETE_PATH_TAIL_RE.test(prevText)) return null;

    // (b) prev tail must look like an in-flight path fragment
    if (!TerminalLinkManager.PATH_FRAGMENT_TAIL_RE.test(prevText)) return null;

    // (c) here, after indent, must have a path-shaped first word
    const hereText = here.translateToString(true);
    if (hereText.length === 0) return null;

    const indented = hereText.match(/^([ \t]*)(\S+)/);
    if (!indented) return null;
    const indent = indented[1]!.length;
    const firstWord = indented[2]!;

    const isPathShaped =
      firstWord.includes('/') ||
      firstWord.includes('\\') ||
      /\.[A-Za-z]{1,6}(?:[^A-Za-z0-9]|$)/.test(firstWord);
    if (!isPathShaped) return null;

    return { indent };
  }

  private extractFileLinksFromStitched(
    stitched: { text: string; positions: Array<{ x: number; y: number }> },
    terminalId: string
  ): ILink[] {
    const links: ILink[] = [];
    const seen = new Set<string>();

    // Phase 1: absolute / explicit-relative paths (original behaviour).
    this._collectMatches(
      stitched,
      terminalId,
      this.absoluteOrExplicitRelativeRegex,
      /* captureGroup */ 0,
      seen,
      links
    );

    // Phase 2: implicit workspace-relative paths with an extension
    // (patch ruben). The regex has a leading boundary alternative to
    // keep it from matching mid-word like "foo/bar.ts" inside "abcfoo/bar.ts",
    // so the actual path lives in capture group 1.
    this._collectMatches(
      stitched,
      terminalId,
      this.implicitRelativeRegex,
      /* captureGroup */ 1,
      seen,
      links
    );

    return links;
  }

  private _collectMatches(
    stitched: { text: string; positions: Array<{ x: number; y: number }> },
    terminalId: string,
    regex: RegExp,
    captureGroup: number,
    seen: Set<string>,
    out: ILink[]
  ): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stitched.text)) !== null) {
      const raw = match[captureGroup];
      if (!raw) continue;

      // Offset of the captured group within the full match. For group 0
      // this is always 0; for group 1 (implicit-relative) we skip past any
      // leading boundary character the outer regex consumed.
      const captureOffsetInMatch = match[0].indexOf(raw);
      if (captureOffsetInMatch < 0) continue;
      const captureStart = match.index + captureOffsetInMatch;

      const cleaned = this.cleanLinkText(raw);
      if (!cleaned) continue;

      const key = `${captureStart}:${cleaned}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const parsed = this.parseFileLink(cleaned);
      if (!parsed) continue;

      const startOffset = captureStart;
      const endOffsetInclusive = startOffset + cleaned.length - 1;
      const startPos = stitched.positions[startOffset];
      const endPos = stitched.positions[endOffsetInclusive];
      if (!startPos || !endPos) continue;

      const link: ILink = {
        text: cleaned,
        range: {
          start: { x: startPos.x, y: startPos.y },
          end: { x: endPos.x + 1, y: endPos.y },
        },
        decorations: {
          pointerCursor: true,
          underline: true,
        },
        activate: (event: MouseEvent, linkText: string) => {
          if (!this.isValidLinkActivation(event)) {
            terminalLogger.debug(`Link activation blocked - modifier key not pressed: ${linkText}`);
            return;
          }
          terminalLogger.info(
            `🔗 File link activated: ${linkText} (meta=${event.metaKey}, ctrl=${event.ctrlKey}, alt=${event.altKey})`
          );
          this.openFile(parsed, terminalId);
        },
        hover: () => {},
        leave: () => {},
      };

      out.push(link);
    }
  }

  /**
   * Clean trailing punctuation and brackets from link text
   */
  private cleanLinkText(text: string): string | null {
    if (!text) return null;

    // Remove trailing punctuation that's likely not part of the path
    let cleaned = text.replace(/[,;:.'"`)\]}>]+$/, '');

    // Handle matched brackets/quotes at the end
    const brackets: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };
    while (cleaned.length > 0) {
      const lastChar = cleaned[cleaned.length - 1];
      if (lastChar === undefined) break;
      const openChar = brackets[lastChar];
      if (openChar && !cleaned.includes(openChar)) {
        cleaned = cleaned.slice(0, -1);
      } else {
        break;
      }
    }

    return cleaned || null;
  }

  /**
   * Parse file path with optional line/range suffix.
   *
   * Two suffix dialects, both supported:
   *   colon: foo.ts, foo.ts:42, foo.ts:42:5, foo.ts:42-50, foo.ts:42:5-50:10
   *   hash:  foo.ts, foo.ts#L42, foo.ts#L42-L175, foo.ts#L42C5-L175C10
   *
   * Patch (ruben, round 2): hash-style added because Claude Code emits its
   * file references in GitHub fragment form (`path.ts#L66-L175`). The two
   * dialects are mutually exclusive on a single token, so we try hash
   * first (it's anchored to a `#`, so unambiguous) then fall back to the
   * colon parser.
   */
  private parseFileLink(text: string): ParsedFileLink | null {
    // Skip URLs
    if (text.includes('://')) return null;

    // Hash style: path#L42 / path#L42-L175 / path#L42C5-L175C10
    const hashMatch = text.match(/^(.+?)#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/);
    if (hashMatch && hashMatch[1]) {
      const path = hashMatch[1];
      if (!this.isValidFilePath(path)) return null;
      return {
        path,
        line: parseInt(hashMatch[2]!, 10),
        column: hashMatch[3] ? parseInt(hashMatch[3], 10) : undefined,
        endLine: hashMatch[4] ? parseInt(hashMatch[4], 10) : undefined,
        endColumn: hashMatch[5] ? parseInt(hashMatch[5], 10) : undefined,
      };
    }

    // Colon style: path / path:42 / path:42:5 / path:42-50 / path:42:5-50:10
    const colonMatch = text.match(/^(.+?)(?::(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?)?$/);
    if (!colonMatch || !colonMatch[1]) return null;

    const path = colonMatch[1];
    if (!this.isValidFilePath(path)) return null;

    return {
      path,
      line: colonMatch[2] ? parseInt(colonMatch[2], 10) : undefined,
      column: colonMatch[3] ? parseInt(colonMatch[3], 10) : undefined,
      endLine: colonMatch[4] ? parseInt(colonMatch[4], 10) : undefined,
      endColumn: colonMatch[5] ? parseInt(colonMatch[5], 10) : undefined,
    };
  }

  /**
   * Check if a string looks like a valid file path.
   *
   * Patch (ruben): relaxed. The regex layer already filters which strings
   * reach this method — one of two patterns must have matched, each with
   * its own safety criteria. At this point we just need at least one path
   * separator to call it a path at all.
   */
  private isValidFilePath(path: string): boolean {
    return path.includes('/') || path.includes('\\');
  }

  /**
   * Open a file in the editor
   */
  private openFile(link: ParsedFileLink, terminalId: string): void {
    this.coordinator?.postMessageToExtension({
      command: 'openTerminalLink',
      linkType: 'file',
      filePath: link.path,
      lineNumber: link.line,
      columnNumber: link.column,
      endLineNumber: link.endLine,
      endColumnNumber: link.endColumn,
      terminalId,
      timestamp: Date.now(),
    });
  }

  /**
   * Open a URL in the browser (kept for compatibility)
   */
  public openUrlFromTerminal(url: string, terminalId: string): void {
    this.coordinator?.postMessageToExtension({
      command: 'openTerminalLink',
      linkType: 'url',
      url,
      terminalId,
      timestamp: Date.now(),
    });
  }

  /**
   * Unregister link provider for a terminal
   */
  public unregisterTerminalLinkProvider(terminalId: string): void {
    const disposable = this.linkProviderDisposables.get(terminalId);
    if (disposable) {
      disposable.dispose();
      this.linkProviderDisposables.delete(terminalId);
    }
  }

  /**
   * Get all registered terminal IDs
   */
  public getRegisteredTerminals(): string[] {
    return Array.from(this.linkProviderDisposables.keys());
  }

  protected doDispose(): void {
    this.linkProviderDisposables.forEach((d) => d.dispose());
    this.linkProviderDisposables.clear();
    terminalLogger.info('TerminalLinkManager disposed');
  }
}
