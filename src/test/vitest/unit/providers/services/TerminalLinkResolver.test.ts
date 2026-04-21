/**
 * TerminalLinkResolver Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { TerminalLinkResolver } from '../../../../../providers/services/TerminalLinkResolver';

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    stat: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    promises: mockFs,
  },
  promises: mockFs,
}));

// Mock VS Code API
vi.mock('vscode', () => ({
  Uri: {
    parse: vi.fn((url) => ({ toString: () => url })),
    file: vi.fn((path) => ({ fsPath: path, scheme: 'file' })),
  },
  env: {
    openExternal: vi.fn().mockResolvedValue(true),
  },
  workspace: {
    openTextDocument: vi.fn().mockResolvedValue({}),
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    findFiles: vi.fn().mockResolvedValue([]),
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
  },
  window: {
    showTextDocument: vi.fn().mockResolvedValue({
      selection: {},
      revealRange: vi.fn(),
    }),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
  },
  Position: class {
    constructor(
      public line: number,
      public character: number
    ) {}
  },
  Selection: class {
    constructor(
      public anchor: any,
      public active: any
    ) {}
  },
  Range: class {
    constructor(
      public start: any,
      public end: any
    ) {}
  },
  TextEditorRevealType: { InCenter: 1 },
}));

// Mock logger
vi.mock('../../../../../utils/logger', () => ({
  provider: vi.fn(),
}));

// Mock feedback
vi.mock('../../../../../utils/feedback', () => ({
  showError: vi.fn(),
}));

describe('TerminalLinkResolver', () => {
  let resolver: TerminalLinkResolver;
  let mockGetTerminal: any;

  beforeEach(() => {
    mockGetTerminal = vi.fn();
    resolver = new TerminalLinkResolver(mockGetTerminal);
    vi.clearAllMocks();
  });

  describe('normalizeLinkPath', () => {
    it('should expand tilde to home directory', () => {
      const home = os.homedir();
      expect(resolver.normalizeLinkPath('~/test.txt')).toBe(path.join(home, 'test.txt'));
    });

    it('should normalize separators', () => {
      const result = resolver.normalizeLinkPath('a\\b\\c');
      // On Windows, path.sep is '\', on POSIX it's '/'
      // The implementation converts '\' to path.sep for cross-platform compatibility
      expect(result).toBe(`a${path.sep}b${path.sep}c`);
    });
  });

  describe('handleOpenTerminalLink', () => {
    it('should handle URL links', async () => {
      await resolver.handleOpenTerminalLink({
        command: 'openTerminalLink',
        linkType: 'url',
        url: 'https://github.com',
      });

      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it('should handle file links with line numbers', async () => {
      // Mock file exists
      mockFs.stat.mockResolvedValue({ isFile: () => true });

      await resolver.handleOpenTerminalLink({
        command: 'openTerminalLink',
        linkType: 'file',
        filePath: 'test.ts',
        lineNumber: 10,
        columnNumber: 5,
      });

      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('should show error if file not found', async () => {
      mockFs.stat.mockRejectedValue({ code: 'ENOENT' });

      await resolver.handleOpenTerminalLink({
        command: 'openTerminalLink',
        linkType: 'file',
        filePath: 'missing.ts',
      });

      const { showError } = await import('../../../../../utils/feedback');
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('Unable to locate file'));
    });
  });

  // Patch (ruben): suffix-match fallback. When direct candidates all miss,
  // the resolver should try to find a workspace file whose path ends with
  // the requested suffix at segment boundaries.
  describe('resolveFileLink suffix-match fallback', () => {
    beforeEach(() => {
      // Default: no direct file exists anywhere — forces the suffix path.
      mockFs.stat.mockRejectedValue({ code: 'ENOENT' });
    });

    it('opens a single suffix match without prompting', async () => {
      const hit = { fsPath: '/workspace/life-sandbox/finance/foo.ts' };
      (vscode.workspace.findFiles as any).mockResolvedValue([hit]);

      const uri = await resolver.resolveFileLink('finance/foo.ts');

      expect(uri).toBe(hit);
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/foo.ts', undefined, 200);
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('rejects mid-segment suffix collisions', async () => {
      // `ance/foo.ts` is a substring of `finance/foo.ts` but not at a
      // segment boundary — must NOT match.
      (vscode.workspace.findFiles as any).mockResolvedValue([
        { fsPath: '/workspace/finance/foo.ts' },
      ]);

      const uri = await resolver.resolveFileLink('ance/foo.ts');

      expect(uri).toBeNull();
    });

    it('filters candidates that share a basename but wrong path', async () => {
      // findFiles returns every `foo.ts` in the workspace; only the one
      // matching the requested suffix should win.
      (vscode.workspace.findFiles as any).mockResolvedValue([
        { fsPath: '/workspace/other/foo.ts' },
        { fsPath: '/workspace/life-sandbox/finance/foo.ts' },
        { fsPath: '/workspace/unrelated/nested/foo.ts' },
      ]);

      const uri = await resolver.resolveFileLink('finance/foo.ts');

      expect(uri).toEqual({ fsPath: '/workspace/life-sandbox/finance/foo.ts' });
    });

    it('prompts on multiple matches and returns the user pick', async () => {
      const a = { fsPath: '/workspace/a/foo.ts' };
      const b = { fsPath: '/workspace/b/foo.ts' };
      (vscode.workspace.findFiles as any).mockResolvedValue([a, b]);
      (vscode.window.showQuickPick as any).mockResolvedValue({ uri: b });

      const uri = await resolver.resolveFileLink('foo.ts');

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(uri).toBe(b);
    });

    it('skips the suffix fallback for absolute paths', async () => {
      const absPath = path.resolve('/abs/missing.ts');
      const uri = await resolver.resolveFileLink(absPath);

      expect(uri).toBeNull();
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });

    it('returns null when no suffix matches', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([]);

      const uri = await resolver.resolveFileLink('missing/thing.ts');

      expect(uri).toBeNull();
    });
  });

  describe('buildPathCandidates', () => {
    it('should include terminal CWD if provided', () => {
      mockGetTerminal.mockReturnValue({ cwd: '/terminal/cwd' });
      const candidates = resolver.buildPathCandidates('rel.txt', 't1');

      expect(candidates).toContain(path.resolve('/terminal/cwd', 'rel.txt'));
    });

    it('should use absolute path directly', () => {
      const abs = path.resolve('/abs/path.txt');
      const candidates = resolver.buildPathCandidates(abs);

      expect(candidates).toEqual([abs]);
    });
  });
});
