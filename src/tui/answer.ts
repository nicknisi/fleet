import { stripAnsi } from '../terminal/ansi.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

// Claude Code's AskUserQuestion form, as drawn by Claude Code 2.1.280. Other
// Claude selection dialogs share its navigation footer, so a question page also
// needs the form's own "Chat about this" option just above it, and the final
// page its submit review. Permission and plan-approval prompts match neither.
const FORM_FOOTER = /^\s*Enter to select · (?:Tab\/Arrow keys|↑\/↓) to navigate(?: · .*)? · Esc to cancel$/;
const CHAT_OPTION = /^\s*(?:❯\s*)?\d+\. Chat about this$/;
const REVIEW_PROMPT = /^\s*Ready to submit your answers\?$/;
const SUBMIT_OPTION = /^\s*(?:❯\s*)?\d+\. Submit answers$/;
const CANCEL_OPTION = /^\s*(?:❯\s*)?\d+\. Cancel$/;

// True while the pane's last drawn content is an AskUserQuestion form, so text
// earlier in the transcript can never qualify. An unrecognized rendering is
// treated as no form: nothing is forwarded to it.
export function isClaudeQuestionForm(lines: string[]): boolean {
  const rows = lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.length > 0);
  const end = rows.length - 1;
  if (end < 0) return false;
  const near = (pattern: RegExp, span: number) =>
    rows.slice(Math.max(0, end - span), end).some((row) => pattern.test(row));
  const last = rows[end]!;
  if (FORM_FOOTER.test(last)) return near(CHAT_OPTION, 3);
  return CANCEL_OPTION.test(last) && near(SUBMIT_OPTION, 2) && near(REVIEW_PROMPT, 3);
}

// Rows whose native question S answers in place instead of refusing to send.
export function answersQuestionInPlace(state: AgentState): boolean {
  return state.agentType === 'claude' && state.status === AgentStatus.QUESTION;
}
