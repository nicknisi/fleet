// A submit/skip key can close the native form before the rest of one stdin
// read is processed. Forward only through that key; never carry its suffix
// into the next question or the main composer. Paste payloads stay opaque.
export class AnswerInput {
  private inPaste = false;

  constructor(private readonly agentType: string) {}

  prefix(data: Buffer): Buffer {
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x1b && data[i + 1] === 0x5b) {
        let end = i + 2;
        while (end < data.length && !(data[end]! >= 0x40 && data[end]! <= 0x7e)) end++;
        if (end === data.length) break;
        const sequence = data.toString('ascii', i, end + 1);
        if (sequence === '\x1b[200~') this.inPaste = true;
        else if (sequence === '\x1b[201~') this.inPaste = false;
        else if (!this.inPaste && this.agentType === 'codex' && sequence === '\x1b[1;3B')
          return data.subarray(0, end + 1); // Alt-Down returns to the main prompt.
        i = end;
      } else if (!this.inPaste && (data[i] === 0x0d || (this.agentType === 'codex' && data[i] === 0x1d))) {
        return data.subarray(0, i + 1);
      }
    }
    return data;
  }
}
