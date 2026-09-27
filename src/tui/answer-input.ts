// A submit/skip key can close the native form before the rest of one stdin
// read is processed. Forward only through that key; never carry its suffix
// into the next question or the main composer. Recognized bracketed-paste
// payloads stay opaque; ordinary unframed CR input is a submit key.
export type CodexInputFocus = 'editing' | 'options' | 'async-editing' | 'async-options';

export class AnswerInput {
  private inPaste = false;
  private pasteHasText = false;

  constructor(private readonly agentType: string) {}

  prefix(data: Buffer, focus: CodexInputFocus = 'editing'): Buffer {
    let options = focus === 'options' || focus === 'async-options';
    const asyncForm = focus === 'async-options' || focus === 'async-editing';
    // A navigation/editing control may change Codex's focus. If digits follow
    // it in the same read, stop there and require a fresh native snapshot.
    let lastDigit = -1;
    for (let i = 0; i < data.length; i++) if (data[i]! >= 0x31 && data[i]! <= 0x39) lastDigit = i;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x1b && data[i + 1] === 0x5b) {
        let end = i + 2;
        while (end < data.length && !(data[end]! >= 0x40 && data[end]! <= 0x7e)) end++;
        if (end === data.length) break;
        const sequence = data.toString('ascii', i, end + 1);
        if (sequence === '\x1b[200~') {
          this.inPaste = true;
          this.pasteHasText = false;
        } else if (sequence === '\x1b[201~') {
          this.inPaste = false;
          if (this.pasteHasText) options = false;
        } else if (!this.inPaste && this.agentType === 'codex' && sequence === '\x1b[1;3B')
          return data.subarray(0, end + 1); // Alt-Down returns to the main prompt.
        else if (
          !this.inPaste &&
          this.agentType === 'codex' &&
          end < lastDigit &&
          (options || (asyncForm && /^\[[0-9;]*[AB]$/.test(sequence.slice(1))))
        )
          return data.subarray(0, end + 1);
        i = end;
      } else if (this.inPaste) {
        this.pasteHasText = true;
      } else if (data[i] === 0x0d || (this.agentType === 'codex' && data[i] === 0x1d)) {
        return data.subarray(0, i + 1);
      } else if (this.agentType === 'codex') {
        const byte = data[i]!;
        if (options && byte >= 0x31 && byte <= 0x39) return data.subarray(0, i + 1);
        // Tab changes field focus or queues an async answer. Backspace on
        // empty notes and question navigation can also leave the text field.
        if (byte === 0x09 || ([0x08, 0x7f, 0x10, 0x0e].includes(byte) && i < lastDigit)) return data.subarray(0, i + 1);
        // Async questions switch to Other on ordinary text; built-in choice
        // pages ignore it. Numbers in an already visible text field stay text.
        if (asyncForm && byte >= 0x20 && byte !== 0x7f) options = false;
      }
    }
    return data;
  }
}
