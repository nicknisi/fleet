import { C } from '../terminal/colors.ts';

export function renderHelp(): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${C.bold}  Fleet — Keybindings${C.reset}`);
  lines.push('');
  lines.push(`  ${C.yellowBold}↑/↓ or j/k${C.reset}${C.gray}  Navigate sessions${C.reset}`);
  lines.push(`  ${C.yellowBold}Enter${C.reset}${C.gray}       Switch to session${C.reset}`);
  lines.push(`  ${C.yellowBold}n${C.reset}${C.gray}           Jump to next waiting agent${C.reset}`);
  lines.push(`  ${C.yellowBold}p${C.reset}${C.gray}           Toggle preview pane${C.reset}`);
  lines.push(`  ${C.yellowBold}s${C.reset}${C.gray}           Send prompt to session${C.reset}`);
  lines.push(`  ${C.yellowBold}/${C.reset}${C.gray}           Filter sessions by name${C.reset}`);
  lines.push(`  ${C.yellowBold}x${C.reset}${C.gray}           Kill selected session (asks to confirm)${C.reset}`);
  lines.push(`  ${C.yellowBold}?${C.reset}${C.gray}           This help${C.reset}`);
  lines.push(`  ${C.yellowBold}q or Esc${C.reset}${C.gray}    Quit${C.reset}`);
  lines.push('');
  lines.push(`  ${C.bold}Preview Quick Actions${C.reset}`);
  lines.push('');
  lines.push(`  ${C.yellowBold}i${C.reset}${C.gray}           Enter passthrough (forward keys to pane)${C.reset}`);
  lines.push(`  ${C.yellowBold}y${C.reset}${C.gray}           Approve permission prompt${C.reset}`);
  lines.push(`  ${C.yellowBold}n${C.reset}${C.gray}           Deny permission prompt (or next agent)${C.reset}`);
  lines.push(`  ${C.yellowBold}Esc${C.reset}${C.gray}         Exit passthrough mode${C.reset}`);
  lines.push('');
  lines.push(`  ${C.gray}Press any key to close${C.reset}`);
  return lines;
}
