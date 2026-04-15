/**
 * Terminal Link Resolver
 *
 * Handles terminal link opening (file links and URLs)
 * Extracted from SecondaryTerminalProvider for better separation of concerns
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fsPromises } from 'fs';
import { provider as log } from '../../utils/logger';
import { showError } from '../../utils/feedback';
import { WebviewMessage } from '../../types/common';
import { safeProcessCwd } from '../../utils/common';

/**
 * Terminal information interface for CWD resolution
 */
export interface TerminalInfo {
  cwd?: string;
}

/**
 * Terminal Link Resolver
 *
 * Responsibilities:
 * - URL link opening in external browser
 * - File link resolution with multiple path candidates
 * - File opening in editor with line/column navigation
 * - Path normalization and candidate building
 */
export class TerminalLinkResolver {
  constructor(private readonly getTerminal: (terminalId: string) => TerminalInfo | undefined) {}

  /**
   * Handle terminal link opening
   */
  public async handleOpenTerminalLink(message: WebviewMessage): Promise<void> {
    const linkType = message.linkType;
    if (!linkType) {
      log('🔗 [LINK-RESOLVER] Link message missing linkType');
      return;
    }

    // Handle URL links
    if (linkType === 'url') {
      await this._handleUrlLink(message);
      return;
    }

    // Handle file links
    await this._handleFileLink(message);
  }

  /**
   * Handle URL link opening
   */
  private async _handleUrlLink(message: WebviewMessage): Promise<void> {
    const targetUrl = message.url;
    if (!targetUrl) {
      log('🔗 [LINK-RESOLVER] URL link missing url field');
      return;
    }

    // Patch (ruben): file:// URLs should open in the editor, not be kicked
    // out to Finder via openExternal. Parse the URL into its path +
    // optional line/col/range components and delegate to the same
    // file-opening logic used for bare paths.
    if (/^file:\/\//i.test(targetUrl)) {
      const parsed = this._parseFileUrl(targetUrl);
      if (parsed) {
        log(
          `🔗 [LINK-RESOLVER] file:// URL routed as file link: ${parsed.filePath}` +
            (parsed.lineNumber ? `:${parsed.lineNumber}` : '')
        );
        await this._handleFileLink({
          ...message,
          linkType: 'file',
          filePath: parsed.filePath,
          lineNumber: parsed.lineNumber,
          columnNumber: parsed.columnNumber,
          endLineNumber: parsed.endLineNumber,
          endColumnNumber: parsed.endColumnNumber,
        } as WebviewMessage);
        return;
      }
      log(
        `⚠️ [LINK-RESOLVER] Could not parse file:// URL, falling back to openExternal: ${targetUrl}`
      );
    }

    try {
      log(`🔗 [LINK-RESOLVER] Opening URL from terminal: ${targetUrl}`);
      await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
    } catch (error) {
      log('❌ [LINK-RESOLVER] Failed to open URL link:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      showError(`Failed to open link in browser. ${errorMessage}`);
    }
  }

  /**
   * Parse a file:// URL into the pieces we need for _handleFileLink.
   *
   * Accepted forms (all via a #fragment or : suffix):
   *   file:///abs/path
   *   file:///abs/path:42
   *   file:///abs/path:42:5
   *   file:///abs/path:42-50
   *   file:///abs/path:42:5-50:10
   *   file:///abs/path#L42
   *   file:///abs/path#L42-L50
   *   file:///abs/path#L42C5-L50C10
   */
  private _parseFileUrl(url: string): {
    filePath: string;
    lineNumber?: number;
    columnNumber?: number;
    endLineNumber?: number;
    endColumnNumber?: number;
  } | null {
    let filePath: string;
    let locator = '';

    // Split off a #fragment if present — that's how GitHub-style line
    // references travel through URLs.
    const hashAt = url.indexOf('#');
    let base = url;
    if (hashAt >= 0) {
      base = url.slice(0, hashAt);
      locator = url.slice(hashAt + 1);
    }

    try {
      const parsed = vscode.Uri.parse(base, true);
      filePath = parsed.fsPath;
    } catch {
      return null;
    }
    if (!filePath) return null;

    // If no #fragment, allow an embedded :line:col-line:col suffix on
    // the path itself.
    if (!locator) {
      const suffixMatch = filePath.match(/^(.*?)(:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/);
      if (suffixMatch && suffixMatch[1] && suffixMatch[2]) {
        filePath = suffixMatch[1];
        locator = suffixMatch[2].slice(1); // drop leading colon
      }
    }

    if (!locator) {
      return { filePath };
    }

    // Two formats: colon-delimited (42, 42:5, 42-50, 42:5-50:10) or
    // GitHub-style L/C-prefixed (L42, L42-L50, L42C5-L50C10).
    const githubStyle = locator.match(/^L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/i);
    if (githubStyle) {
      return {
        filePath,
        lineNumber: parseInt(githubStyle[1]!, 10),
        columnNumber: githubStyle[2] ? parseInt(githubStyle[2], 10) : undefined,
        endLineNumber: githubStyle[3] ? parseInt(githubStyle[3], 10) : undefined,
        endColumnNumber: githubStyle[4] ? parseInt(githubStyle[4], 10) : undefined,
      };
    }

    const colonStyle = locator.match(/^(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/);
    if (colonStyle) {
      return {
        filePath,
        lineNumber: parseInt(colonStyle[1]!, 10),
        columnNumber: colonStyle[2] ? parseInt(colonStyle[2], 10) : undefined,
        endLineNumber: colonStyle[3] ? parseInt(colonStyle[3], 10) : undefined,
        endColumnNumber: colonStyle[4] ? parseInt(colonStyle[4], 10) : undefined,
      };
    }

    // Unknown locator format — ignore it and open the file at the top.
    return { filePath };
  }

  /**
   * Handle file link opening
   */
  private async _handleFileLink(message: WebviewMessage): Promise<void> {
    const filePath = message.filePath;
    if (!filePath) {
      log('🔗 [LINK-RESOLVER] File link missing filePath');
      return;
    }

    const resolvedUri = await this.resolveFileLink(filePath, message.terminalId);
    if (!resolvedUri) {
      showError(`Unable to locate file from terminal link. Path: ${filePath}`);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(resolvedUri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });

      // Navigate to specific line/column if provided. Patch (ruben):
      // endLineNumber/endColumnNumber support — if present, open with a
      // real multi-line selection instead of a collapsed caret. Useful
      // for code review links like "file.ts:42-50".
      if (typeof message.lineNumber === 'number' && !Number.isNaN(message.lineNumber)) {
        const startLine = Math.max(0, message.lineNumber - 1);
        const startCol =
          typeof message.columnNumber === 'number' && !Number.isNaN(message.columnNumber)
            ? Math.max(0, message.columnNumber - 1)
            : 0;
        const startPos = new vscode.Position(startLine, startCol);

        const hasEndLine =
          typeof message.endLineNumber === 'number' && !Number.isNaN(message.endLineNumber);
        let endPos = startPos;
        if (hasEndLine) {
          const endLine = Math.max(0, (message.endLineNumber as number) - 1);
          const endLineText = document.lineAt(Math.min(endLine, document.lineCount - 1));
          const endCol =
            typeof message.endColumnNumber === 'number' && !Number.isNaN(message.endColumnNumber)
              ? Math.max(0, (message.endColumnNumber as number) - 1)
              : endLineText.range.end.character;
          endPos = new vscode.Position(endLine, endCol);
        }

        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(
          new vscode.Range(startPos, endPos),
          vscode.TextEditorRevealType.InCenter
        );
      }

      log(`🔗 [LINK-RESOLVER] Opened file link: ${resolvedUri.fsPath}`);
    } catch (error) {
      log('❌ [LINK-RESOLVER] Failed to open file link:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      showError(`Failed to open file from terminal link. ${errorMessage}`);
    }
  }

  /**
   * Resolve file link to VS Code URI
   *
   * Tries multiple path candidates:
   * 1. Terminal CWD + relative path
   * 2. Workspace folders + relative path
   * 3. Process CWD + relative path
   * 4. Absolute path (if provided)
   */
  public async resolveFileLink(filePath: string, terminalId?: string): Promise<vscode.Uri | null> {
    const candidates = this.buildPathCandidates(filePath, terminalId);

    for (const candidate of candidates) {
      try {
        const stat = await fsPromises.stat(candidate);
        if (stat.isFile()) {
          log(`🔗 [LINK-RESOLVER] Resolved file path: ${candidate}`);
          return vscode.Uri.file(candidate);
        }
      } catch (error) {
        // Ignore missing candidates
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('⚠️ [LINK-RESOLVER] Error while checking file candidate:', error);
        }
      }
    }

    log(`❌ [LINK-RESOLVER] Failed to resolve file path: ${filePath}`);
    return null;
  }

  /**
   * Build path candidates for file resolution
   *
   * Generates multiple candidate paths by combining:
   * - Terminal CWD (if available)
   * - Workspace folders
   * - Process CWD
   * - Absolute paths
   */
  public buildPathCandidates(filePath: string, terminalId?: string): string[] {
    const normalizedInput = this.normalizeLinkPath(filePath);
    const candidates = new Set<string>();

    // If absolute path, use it directly
    if (path.isAbsolute(normalizedInput)) {
      candidates.add(normalizedInput);
    } else {
      // Try terminal CWD
      if (terminalId) {
        const terminal = this.getTerminal(terminalId);
        if (terminal?.cwd) {
          candidates.add(path.resolve(terminal.cwd, normalizedInput));
        }
      }

      // Try workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      for (const folder of workspaceFolders) {
        candidates.add(path.resolve(folder.uri.fsPath, normalizedInput));
      }

      // Try process CWD
      candidates.add(path.resolve(safeProcessCwd(), normalizedInput));
    }

    const candidateArray = Array.from(candidates);
    log(`🔗 [LINK-RESOLVER] Path candidates for "${filePath}":`, candidateArray);
    return candidateArray;
  }

  /**
   * Normalize link path
   *
   * Handles:
   * - Tilde expansion (~/)
   * - Path separator normalization
   * - Trimming whitespace
   */
  public normalizeLinkPath(input: string): string {
    let normalized = input.trim();
    if (!normalized) {
      return normalized;
    }

    // Expand tilde to home directory
    if (normalized.startsWith('~')) {
      normalized = path.join(os.homedir(), normalized.slice(1));
    }

    // Convert Windows-style separators to native separators
    normalized = normalized.replace(/\\/g, path.sep);

    return normalized;
  }
}
