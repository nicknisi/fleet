import { TuiMode, type TuiApp } from './app.ts';
import { renderHeader, renderSessionList, renderFooter } from './dashboard.ts';
import { renderPreview } from './preview.ts';
import { renderSendMode } from './send.ts';
import { renderHelp } from './help.ts';
import { C } from '../terminal/colors.ts';
import type { TerminalSize } from '../terminal/terminal.ts';

export function render(app: TuiApp, size: TerminalSize): string {
  const out: string[] = [];
  out.push('\x1b[2J\x1b[H');

  if (size.cols < 20 || size.rows < 6) {
    out.push(`${C.gray}Terminal too small${C.reset}`);
    return out.join('');
  }

  // Header (row 1)
  out.push(renderHeader(app, size.cols));
  out.push('\r\n');

  const contentRows = size.rows - 3;

  if (app.mode === TuiMode.HELP) {
    const helpLines = renderHelp();
    for (const line of helpLines.slice(0, contentRows)) {
      out.push(line + '\r\n');
    }
  } else if (app.mode === TuiMode.SEND) {
    const selected = app.selectedState();
    if (selected) {
      out.push('\r\n');
      const sendLines = renderSendMode(selected, app.sendBuffer, size.cols);
      for (const line of sendLines.slice(0, contentRows)) {
        out.push(line + '\r\n');
      }
    }
  } else if (app.mode === TuiMode.PREVIEW) {
    const selected = app.selectedState();
    const listWidth = Math.floor(size.cols * 0.45);
    const previewWidth = size.cols - listWidth - 1;

    out.push('\r\n');
    const sessionLines = renderSessionList(app, contentRows, listWidth);
    const previewLines = selected ? renderPreview(selected, previewWidth, contentRows) : [];

    for (let row = 0; row < contentRows; row++) {
      const sessionLine = sessionLines[row] ?? '';
      const previewLine = previewLines[row] ?? '';
      out.push(sessionLine);
      // Pad session line to listWidth
      const sessionVis = visibleLengthFast(sessionLine);
      if (sessionVis < listWidth) out.push(' '.repeat(listWidth - sessionVis));
      out.push(`${C.gray}│${C.reset}`);
      out.push(previewLine);
      out.push('\r\n');
    }
  } else {
    // Dashboard mode
    out.push('\r\n');
    const sessionLines = renderSessionList(app, contentRows, size.cols);
    for (const line of sessionLines) {
      out.push(line + '\r\n');
    }
  }

  // Footer (last row)
  out.push(`\x1b[${size.rows};1H`);
  out.push(renderFooter(app, size.cols));

  return out.join('');
}

function visibleLengthFast(s: string): number {
  // Quick approximation — strip ANSI codes
  // oxlint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;:]*[@-~]/g, '').length;
}
