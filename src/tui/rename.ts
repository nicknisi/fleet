import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import type { AgentState } from '../state/types.ts';

export function renderRenameMode(state: AgentState, buffer: string, cols: number): string[] {
  return [
    `${C.bold}Rename ${state.session}${C.reset}`,
    '',
    `${C.gray}Type a name, Enter to save, Esc to cancel. Empty clears the rename.${C.reset}`,
    '',
    truncateAnsi(`${C.cyan}> ${C.reset}${buffer}█`, cols),
  ];
}
