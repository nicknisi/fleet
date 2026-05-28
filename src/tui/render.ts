import { TuiMode, type TuiApp } from './app.ts';
import { renderHeader, renderSessionList, renderFooter } from './dashboard.ts';
import { renderPreview } from './preview.ts';
import { renderSendMode } from './send.ts';
import { renderHelp } from './help.ts';
import { C } from '../terminal/colors.ts';
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
  const contentRows = rows - headerLines.length - footerLines.length - 1;
  let linesWritten = 0;

  if (app.mode === TuiMode.HELP) {
    const helpLines = renderHelp();
    for (let i = 0; i < contentRows; i++) {
      out.push((helpLines[i] ?? '') + '\x1b[K\r\n');
      linesWritten++;
    }
  } else if (app.mode === TuiMode.SEND) {
    const selected = app.selectedState();
    if (selected) {
      out.push('\x1b[K\r\n');
      linesWritten++;
      const sendLines = renderSendMode(selected, app.sendBuffer, cols);
      for (let i = 0; i < contentRows - 1 && i < sendLines.length; i++) {
        out.push(sendLines[i]! + '\x1b[K\r\n');
        linesWritten++;
      }
    }
  } else if (app.mode === TuiMode.PREVIEW || app.mode === TuiMode.PASSTHROUGH) {
    const selected = app.selectedState();
    const isPassthrough = app.mode === TuiMode.PASSTHROUGH;
    const listWidth = Math.floor(cols * 0.45);
    const previewWidth = cols - listWidth - 1;

    out.push('\x1b[K\r\n');
    linesWritten++;
    const sessionLines = renderSessionList(app, contentRows, listWidth);
    const previewLines = selected ? renderPreview(selected, previewWidth, contentRows, isPassthrough) : [];

    for (let row = 0; row < contentRows - 1; row++) {
      const sessionLine = sessionLines[row] ?? '';
      const previewLine = previewLines[row] ?? '';
      out.push(sessionLine);
      const sessionVis = visibleLengthFast(sessionLine);
      if (sessionVis < listWidth) out.push(' '.repeat(listWidth - sessionVis));
      out.push(`${C.gray}│${C.reset}`);
      out.push(previewLine);
      out.push('\x1b[K\r\n');
      linesWritten++;
    }
  } else {
    // Dashboard mode
    out.push('\x1b[K\r\n');
    linesWritten++;
    const sessionLines = renderSessionList(app, contentRows, cols);
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

function visibleLengthFast(s: string): number {
  // Quick approximation — strip ANSI codes
  // oxlint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;:]*[@-~]/g, '').length;
}
