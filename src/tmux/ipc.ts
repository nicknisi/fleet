export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function tmux(args: string[]): TmuxResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ['tmux', ...args],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (err) {
    // tmux binary missing / spawn failure — same shape as a failed command.
    return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

export function tmuxOrNull(args: string[]): string | null {
  const result = tmux(args);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

// `show -gqv` exits 0 with empty output for an unset option — normalized to
// null here so every option read shares one copy of that semantic.
export function getTmuxOption(name: string): string | null {
  return tmuxOrNull(['show', '-gqv', name]);
}

export function tmuxOrThrow(args: string[], label: string): string {
  const result = tmux(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0 ? `${label}: ${detail}` : label);
  }
  return result.stdout;
}
