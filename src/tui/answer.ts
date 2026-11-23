import { stripAnsi } from '../terminal/ansi.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { CODEX_MANIFEST, getCompiledRegex } from '../state/detection.ts';

export type QuestionKind = 'queued' | 'form' | null;

// A form's controls must still be the last drawn content, not an example or
// an answered form left above a new prompt. Use the same observed footers as
// status detection, including compact 0.157 shortcuts and wrapped hints.
export function questionKind(agent: string, lines: string[]): QuestionKind {
  if (agent === 'claude') return isClaudeQuestionForm(lines) ? 'form' : null;
  if (agent !== 'codex') return null;
  const rows = lines.map((line) => stripAnsi(line).trimEnd());
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  const text = rows.slice(-CODEX_MANIFEST.linesFromBottom).join('\n');
  for (const rule of CODEX_MANIFEST.rules) {
    if (rule.state !== 'QUESTION') continue;
    const match = getCompiledRegex(rule)?.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    if (rule.id === 'question.queued-follow-up') {
      // A collapsed queue sits above the main composer, its animated gap and
      // the configurable status line. Expanded forms replace that composer.
      // A later approval footer must never be treated as an answerable queue.
      const approval = CODEX_MANIFEST.rules.some(
        (candidate) => candidate.state === 'PERMIT' && getCompiledRegex(candidate)?.test(rest),
      );
      const tail = rest.split('\n').filter((line) => !/^[\s\u2800-\u28ff]*$/.test(line));
      if (!approval && (tail.length === 0 || /^\s*› /.test(tail[0]!))) return 'queued';
    } else if (!rest.trim()) return 'form';
  }
  return null;
}

export function codexInputFocus(
  lines: string[],
  cursorVisible: boolean,
): 'editing' | 'options' | 'async-editing' | 'async-options' {
  const rule = CODEX_MANIFEST.rules.find((rule) => rule.id === 'question.async-answer')!;
  const asyncForm = getCompiledRegex(rule)!.test(lines.map(stripAnsi).join('\n'));
  return asyncForm ? (cursorVisible ? 'async-editing' : 'async-options') : cursorVisible ? 'editing' : 'options';
}

// Claude Code's AskUserQuestion form. Other
// Claude selection dialogs share its navigation footer, so a question page also
// needs the form's own "Chat about this" option just above it, and the final
// page its submit review. Permission and plan-approval prompts match neither.
const FORM_FOOTER = /^\s*Enter to select · (?:Tab\/Arrow keys|↑\/↓) to navigate(?: · .*)? · Esc to cancel$/;
const CHAT_OPTION = /^\s*(?:❯\s*)?\d+\. Chat about this$/;
const REVIEW_PROMPT = /^\s*Ready to submit your answers\?$/;
const REVIEW_HEADING = /^\s*Review your answers$/;
const REVIEW_QUESTION = /^\s*(?:│ )?● \S/;
const REVIEW_WRAPPED_QUESTION = /^\s*│ ● \S/;
const REVIEW_CONTINUATION = /^\s*│ {3}\S/;
const REVIEW_ANSWER = /^\s*→ \S/;
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
  if (!CANCEL_OPTION.test(last) || !near(SUBMIT_OPTION, 2)) return false;
  if (near(REVIEW_PROMPT, 3)) return true;

  // Claude 2.1.330 omits the confirmation question. Match the rendered
  // question and answer under the newest review heading, above the live
  // controls. The capture bounds the search; a long wrapped review can fill it.
  if (!SUBMIT_OPTION.test(rows[end - 1]!)) return false;
  const review = rows.slice(0, end - 1);
  const heading = review.findLastIndex((row) => REVIEW_HEADING.test(row));
  if (heading < 0) return false;
  return review.slice(heading + 1).some((row, index, answers) => {
    if (!REVIEW_ANSWER.test(row)) return false;
    let question = index - 1;
    // Claude draws a vertical bar on every line of a wrapped question.
    while (REVIEW_CONTINUATION.test(answers[question] ?? '')) question -= 1;
    const questionPattern = question === index - 1 ? REVIEW_QUESTION : REVIEW_WRAPPED_QUESTION;
    return questionPattern.test(answers[question] ?? '');
  });
}

// Rows whose native question S answers in place instead of refusing to send.
export function answersQuestionInPlace(state: AgentState): boolean {
  return ['claude', 'codex'].includes(state.agentType) && state.status === AgentStatus.QUESTION;
}
