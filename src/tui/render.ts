import { TuiMode, type TuiApp } from './app.ts';
import { renderHeader, renderSessionList, renderFooter } from './dashboard.ts';
import { renderPreview } from './preview.ts';
import { renderSendMode } from './send.ts';
import { renderRenameMode } from './rename.ts';
import { renderKillConfirm } from './kill.ts';
import { renderHelp } from './help.ts';
import { C } from '../terminal/colors.ts';
import { visibleLength } from '../terminal/ansi.ts';
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

  if (app.mode === TuiMode.HELP) {
    const helpLines = renderHelp();
    for (let i = 0; i < contentRows; i++) {
      out.push((helpLines[i] ?? '') + '\x1b[K\r\n');
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
    const previewLines = selected ? renderPreview(selected, previewWidth, contentRows - 1, isPassthrough) : [];

    for (let row = 0; row < contentRows - 1; row++) {
      const sessionLine = sessionLines[row] ?? '';
      const previewLine = previewLines[row] ?? '';
      out.push(sessionLine);
      // Must be the same width function the layout builders pad with — a
      // code-unit count (string .length) disagrees on surrogate-pair glyphs
      // like nerd-font icons in window names, shifting the divider per row.
      const sessionVis = visibleLength(sessionLine);
      if (sessionVis < listWidth) out.push(' '.repeat(listWidth - sessionVis));
      out.push(app.dragging ? `${C.cyan}│${C.reset}` : `${C.gray}│${C.reset}`);
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

  return out.join('');
}
