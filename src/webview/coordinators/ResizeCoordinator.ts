/**
 * ResizeCoordinator
 *
 * ターミナルのリサイズ処理を一元管理するコーディネーター
 * LightweightTerminalWebviewManagerから抽出された責務:
 * - ResizeObserverの管理
 * - ウィンドウリサイズイベントの処理
 * - ターミナルのrefit処理
 */

import { webview as log } from '../../utils/logger';
import { DOMUtils } from '../utils/DOMUtils';
import { Debouncer } from '../utils/DebouncedEventBuffer';
import { RESIZE_COORDINATOR_CONSTANTS } from '../constants/webview';

/**
 * リサイズに必要な外部依存
 */
export interface IResizeDependencies {
  getTerminals(): Map<
    string,
    {
      terminal: { cols: number; rows: number; refresh?: (start: number, end: number) => void };
      fitAddon: {
        fit(): void;
        proposeDimensions(): { cols?: number; rows?: number } | undefined;
      } | null;
      container: HTMLElement | null;
    }
  >;
  /**
   * PTYプロセスへリサイズを通知
   * VS Code pattern: fit()後にPTYのcols/rowsを更新する必要がある
   */
  notifyResize?(terminalId: string, cols: number, rows: number): void;
}

export class ResizeCoordinator {
  private parentResizeObserver: ResizeObserver | null = null;
  private bodyResizeObserver: ResizeObserver | null = null;
  private isInitialized = false;
  private readonly boundWindowResizeHandler: () => void;

  // Use Debouncer utility for consistent debouncing
  private readonly parentResizeDebouncer: Debouncer;
  private readonly windowResizeDebouncer: Debouncer;
  private readonly bodyResizeDebouncer: Debouncer;

  constructor(private readonly deps: IResizeDependencies) {
    this.boundWindowResizeHandler = () => this.windowResizeDebouncer.trigger();

    // Initialize debouncers with appropriate delays
    this.parentResizeDebouncer = new Debouncer(
      () => {
        log(`📐 [RESIZE] Triggering refitAllTerminals after debounce`);
        this.refitAllTerminals();
      },
      { delay: RESIZE_COORDINATOR_CONSTANTS.PARENT_RESIZE_DEBOUNCE_MS, name: 'parentResize' }
    );

    this.windowResizeDebouncer = new Debouncer(
      () => {
        log('📐 Window resize detected - refitting all terminals');
        this.refitAllTerminals();
      },
      { delay: RESIZE_COORDINATOR_CONSTANTS.WINDOW_RESIZE_DEBOUNCE_MS, name: 'windowResize' }
    );

    this.bodyResizeDebouncer = new Debouncer(
      () => {
        log('📐 Body resize detected - refitting all terminals');
        this.refitAllTerminals();
      },
      { delay: RESIZE_COORDINATOR_CONSTANTS.BODY_RESIZE_DEBOUNCE_MS, name: 'bodyResize' }
    );

    log('✅ ResizeCoordinator initialized');
  }

  /**
   * リサイズ監視を開始
   */
  public initialize(): void {
    if (this.isInitialized) {
      return;
    }

    this.setupWindowResizeListener();
    this.setupBodyResizeObserver();
    this.isInitialized = true;

    log('✅ ResizeCoordinator fully initialized');
  }

  /**
   * ターミナル親コンテナのResizeObserverを設定
   */
  public setupParentContainerResizeObserver(): void {
    const terminalBody = document.getElementById('terminal-body');
    if (!terminalBody) {
      log('⚠️ terminal-body not found for parent ResizeObserver');
      return;
    }

    log('🔧 Setting up ResizeObserver on document.body, terminal-body, and terminals-wrapper');

    this.parentResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const targetId = (entry.target as HTMLElement).id || 'body';
        log(`📐 [RESIZE] ${targetId} resized: ${width}x${height}`);
        this.parentResizeDebouncer.trigger();
      }
    });

    this.parentResizeObserver.observe(document.body);
    this.parentResizeObserver.observe(terminalBody);

    const terminalsWrapper = document.getElementById('terminals-wrapper');
    if (terminalsWrapper) {
      this.parentResizeObserver.observe(terminalsWrapper);
      log('✅ ResizeObserver also observing terminals-wrapper');
    }

    log('✅ Parent container ResizeObserver setup complete');
  }

  /**
   * ウィンドウリサイズリスナーを設定
   */
  private setupWindowResizeListener(): void {
    window.addEventListener('resize', this.boundWindowResizeHandler);
    log('🔍 Window resize listener added');
  }

  /**
   * ボディリサイズオブザーバーを設定
   */
  private setupBodyResizeObserver(): void {
    this.bodyResizeObserver = new ResizeObserver(() => this.bodyResizeDebouncer.trigger());
    this.bodyResizeObserver.observe(document.body);
    log('🔍 Body ResizeObserver added');
  }

  /**
   * Refit all terminals using double-fit pattern with PTY notification.
   * Uses VS Code pattern: reset styles -> fit() -> wait frame -> fit() -> notify PTY
   *
   * Patch (ruben): skip any terminal whose container is not currently
   * measurable (clientWidth/Height === 0). That happens whenever a terminal
   * is display:none (non-active tab) or the panel hasn't laid out yet. Fit()
   * on such a container computes 0 cols and writes that to the pty, which
   * bakes 1-col-wide newlines into scrollback forever. Never do that.
   */
  public refitAllTerminals(): void {
    try {
      const terminals = this.deps.getTerminals();

      // Reset inline styles only on terminals we're actually going to fit.
      // Touching hidden ones is harmless here but the style reset can make
      // debugging confusing, so we gate on measurability up front.
      terminals.forEach((terminalData) => {
        if (terminalData.container && ResizeCoordinator._isMeasurable(terminalData.container)) {
          DOMUtils.resetXtermInlineStyles(terminalData.container, false);
        }
      });
      DOMUtils.forceReflow();

      requestAnimationFrame(() => {
        terminals.forEach((terminalData, terminalId) => {
          if (!terminalData.fitAddon || !terminalData.terminal || !terminalData.container) {
            return;
          }

          const container = terminalData.container;

          if (!ResizeCoordinator._isMeasurable(container)) {
            log(
              `⏭️ [RESIZE] Skipping ${terminalId}: container is 0-sized (hidden or not laid out)`
            );
            return;
          }

          try {
            // First fit: reset styles and fit
            DOMUtils.resetXtermInlineStyles(container, true);
            terminalData.fitAddon.fit();

            // Second fit: ensures canvas updates correctly (Issue #368)
            // PTY notification must occur AFTER second fit for accurate dimensions
            requestAnimationFrame(() => {
              // Guard: Exit early if terminal was disposed during async operation
              if (!terminalData || !terminalData.terminal || !terminalData.fitAddon) {
                return;
              }

              // Container may have gone hidden between frames (rapid tab
              // switch). Re-check before the second fit to avoid writing 0.
              if (!ResizeCoordinator._isMeasurable(container)) {
                log(`⏭️ [RESIZE] ${terminalId} became 0-sized before second fit, abandoning`);
                return;
              }

              DOMUtils.resetXtermInlineStyles(container, true);
              terminalData.fitAddon.fit();

              const newCols = terminalData.terminal.cols;
              const newRows = terminalData.terminal.rows;

              // Paranoid final guard: xterm's fit() should never return 0
              // when the container is measurable, but if a bug elsewhere
              // produces it, we must not propagate it to the pty.
              if (newCols <= 0 || newRows <= 0) {
                log(
                  `🚫 [RESIZE] ${terminalId} fit() produced invalid dims ${newCols}x${newRows}, not notifying PTY`
                );
                return;
              }

              if (typeof terminalData.terminal.refresh === 'function') {
                const lastRow = Math.max(newRows - 1, 0);
                terminalData.terminal.refresh(0, lastRow);
              }
              if (this.deps.notifyResize) {
                this.deps.notifyResize(terminalId, newCols, newRows);
                log(`📨 PTY resize: ${terminalId} (${newCols}x${newRows})`);
              }

              log(`✅ Terminal ${terminalId} refitted: ${newCols}x${newRows}`);
            });
          } catch (error) {
            log(`⚠️ Failed to refit terminal ${terminalId}:`, error);
          }
        });
      });
    } catch (error) {
      log('❌ Error refitting all terminals:', error);
    }
  }

  /**
   * Patch (ruben): a container is only safe to fit when it has actual
   * layout dimensions. display:none, collapsed flex children, and the
   * brief window before initial layout all return 0 here.
   */
  private static _isMeasurable(container: HTMLElement): boolean {
    return container.clientWidth > 0 && container.clientHeight > 0;
  }

  /**
   * パネル位置変更イベントリスナーを設定
   */
  public setupPanelLocationListener(): void {
    window.addEventListener('terminal-panel-location-changed', () => {
      log('📍 Panel location changed event received - refitting all terminals');
      this.refitAllTerminals();
    });
    log('🔍 Panel location change listener added');
  }

  /**
   * リソース解放
   */
  public dispose(): void {
    if (this.parentResizeObserver) {
      this.parentResizeObserver.disconnect();
      this.parentResizeObserver = null;
    }

    if (this.bodyResizeObserver) {
      this.bodyResizeObserver.disconnect();
      this.bodyResizeObserver = null;
    }

    // Remove window resize listener
    window.removeEventListener('resize', this.boundWindowResizeHandler);

    // Dispose debouncers (cancels pending operations and cleans up timers)
    this.parentResizeDebouncer.dispose();
    this.windowResizeDebouncer.dispose();
    this.bodyResizeDebouncer.dispose();

    this.isInitialized = false;
    log('✅ ResizeCoordinator disposed');
  }
}
