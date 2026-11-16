import { splitMouseEvents } from '../terminal/mouse.ts';

interface InputState {
  shouldQuit: boolean;
  actionError: string | null;
  actionTarget: unknown;
}

// Return true when the exit/error guard changed visible state. Dispatchers
// otherwise decide which input needs a repaint, retaining hover deduplication.
export function dispatchInputBatch(
  app: InputState,
  data: Buffer,
  dispatch: (report: Buffer) => void,
  finished: () => boolean = () => false,
): boolean {
  if (data[0] === 0x03) {
    app.shouldQuit = true;
    return true;
  }
  if (app.actionError && !app.actionTarget) {
    app.actionError = null;
    return true;
  }
  for (const report of splitMouseEvents(data)) {
    if (finished() || app.shouldQuit || (app.actionError && !app.actionTarget)) break;
    dispatch(report);
  }
  return false;
}
