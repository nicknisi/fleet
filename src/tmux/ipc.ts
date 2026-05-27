export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function tmux(args: string[]): TmuxResult {
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
}

export function tmuxOrNull(args: string[]): string | null {
  const result = tmux(args);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

export function tmuxOrThrow(args: string[], label: string): string {
  const result = tmux(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0 ? `${label}: ${detail}` : label);
  }
  return result.stdout;
}
