import { TuiMode, type TuiApp } from './app.ts';
import { renderHeader, renderSessionList, renderFooter } from './dashboard.ts';
import { renderPreviewWithCursor, type PreviewRender } from './preview.ts';
import { renderSendMode } from './send.ts';
import { renderRenameMode } from './rename.ts';
import { renderKillConfirm } from './kill.ts';
import { renderHelp } from './help.ts';
import { renderDecision } from './decision.ts';
import { C } from '../terminal/colors.ts';
import { truncateAnsi, visibleLength } from '../terminal/ansi.ts';
import type { TerminalSize } from '../terminal/terminal.ts';

export function render(app: TuiApp, size: TerminalSize): string {
  const out: string[] = [];
  const { cols, rows } = size;

  // Home cursor (no screen clear — overwrite in place to avoid flicker)
  out.push('\x1b[H');

  if (cols < 20 || rows < 6) {
    out.push(`${C.gray}Terminal too small${C.reset}\x1b[K`);
    return out.join('');
  }

  // Header (may be multiple lines)
  const headerLines = renderHeader(app, cols);
  for (const hl of headerLines) {
    out.push(hl + '\x1b[K\r\n');
  }

  const footerLines = renderFooter(app, cols);
  // Every row between header and footer — all of them are written each frame
  // (the fill loop below), so no row can carry a stale previous frame.
  const contentRows = rows - headerLines.length - footerLines.length;
  let linesWritten = 0;
  // Absolute (1-indexed) screen position of the passthrough caret, applied at
  // the end of the frame. null → hide the hardware cursor (every non-passthrough
  // frame), so the caret only ever shows where you're actually typing.
  let cursorPos: { line: number; col: number } | null = null;

  // SEND/RENAME/CONFIRM_KILL share one modal shape: a spacer, then the modal's
  // lines. null = not a modal mode (or nothing selected — fill loop blanks it).
  const modalLines = ((): string[] | null => {
    const selected = app.selectedState();
    if (!selected) return null;
    switch (app.mode) {
      case TuiMode.SEND:
        return renderSendMode(selected, app.sendBuffer, cols);
      case TuiMode.RENAME:
        return renderRenameMode(selected, app.renameBuffer, cols);
      case TuiMode.CONFIRM_KILL:
        return renderKillConfirm(selected);
      default:
        return null;
    }
  })();

  if (app.mode === TuiMode.HELP || app.mode === TuiMode.DECISION) {
    // Full-screen read-only overlay: help, or the state-provenance panel for
    // the selected agent (falls back to help's blank frame if nothing selected).
    const selected = app.selectedState();
    const overlayLines = app.mode === TuiMode.DECISION && selected ? renderDecision(selected) : renderHelp();
    for (let i = 0; i < contentRows; i++) {
      out.push(truncateAnsi(overlayLines[i] ?? '', cols) + '\x1b[K\r\n');
      linesWritten++;
    }
  } else if (modalLines) {
    out.push('\x1b[K\r\n');
    linesWritten++;
    for (let i = 0; i < contentRows - 1 && i < modalLines.length; i++) {
      out.push(modalLines[i]! + '\x1b[K\r\n');
      linesWritten++;
    }
  } else if (app.mode === TuiMode.PREVIEW || app.mode === TuiMode.PASSTHROUGH) {
    const selected = app.selectedState();
    const isPassthrough = app.mode === TuiMode.PASSTHROUGH;
    const listWidth = app.listWidth(cols);
    const previewWidth = cols - listWidth - 1;

    out.push('\x1b[K\r\n');
    linesWritten++;
    // contentRows - 1: the spacer above consumed one content row.
    const sessionLines = renderSessionList(app, contentRows - 1, listWidth);
    const emptyPreview: PreviewRender = { lines: [], cursor: null };
    const preview = selected
      ? renderPreviewWithCursor(selected, previewWidth, contentRows - 1, isPassthrough)
      : emptyPreview;
    const previewLines = preview.lines;
    // Map the preview-relative caret to an absolute screen cell. Preview array
    // index r renders at screen line (headerLines.length + 2 + r) — one header
    // block, then the spacer row consumed by the split loop. The caret sits in
    // the preview column, which starts one past the divider at listWidth + 2.
    if (isPassthrough && preview.cursor) {
      cursorPos = {
        line: headerLines.length + 2 + preview.cursor.row,
        col: listWidth + 2 + preview.cursor.col,
      };
    }

    for (let row = 0; row < contentRows - 1; row++) {
      const sessionLine = sessionLines[row] ?? '';
      const previewLine = previewLines[row] ?? '';
      out.push(sessionLine);
      // Must be the same width function the layout builders pad with — a
      // code-unit count (string .length) disagrees on surrogate-pair glyphs
      // like nerd-font icons in window names, shifting the divider per row.
      const sessionVis = visibleLength(sessionLine);
      if (sessionVis < listWidth) out.push(' '.repeat(listWidth - sessionVis));
      // Divider affordance: a dim thin line at rest, a bright heavy line the
      // moment the cursor enters the grab zone (hover) or a drag is underway —
      // the glyph visibly thickens so users can tell the line is draggable.
      if (app.dragging) out.push(`${C.cyanBold}┃${C.reset}`);
      else if (app.hoverDivider) out.push(`${C.cyan}┃${C.reset}`);
      else out.push(`${C.gray}│${C.reset}`);
      out.push(previewLine);
      // Preview content is untrusted captured pane ANSI and may leave an open
      // SGR (e.g. a diff line's background). Seal the boundary with a literal
      // reset — unconditional, since the leaking codes are real ANSI even when
      // our own colors are disabled — so it can't bleed through `\x1b[K` or
      // into the next row's list column.
      out.push('\x1b[0m');
      out.push('\x1b[K\r\n');
      linesWritten++;
    }
  } else {
    // Dashboard mode — contentRows - 1 list rows after the spacer.
    out.push('\x1b[K\r\n');
    linesWritten++;
    const sessionLines = renderSessionList(app, contentRows - 1, cols);
    for (const line of sessionLines) {
      out.push(line + '\x1b[K\r\n');
      linesWritten++;
    }
  }

  // Clear remaining content rows
  while (linesWritten < contentRows) {
    out.push('\x1b[K\r\n');
    linesWritten++;
  }

  // Footer (last rows)
  const footerStart = rows - footerLines.length + 1;
  for (let i = 0; i < footerLines.length; i++) {
    out.push(`\x1b[${footerStart + i};1H`);
    out.push(footerLines[i]!);
    out.push('\x1b[K');
  }

  // Caret: show the hardware cursor at the passthrough typing position, or hide
  // it (idempotent) on every other frame. Last write wins over the footer's
  // trailing cursor position.
  if (cursorPos) out.push(`\x1b[${cursorPos.line};${cursorPos.col}H\x1b[?25h`);
  else out.push('\x1b[?25l');

  return out.join('');
}
