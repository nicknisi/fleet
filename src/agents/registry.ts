import { loadAgentDirs, type AgentDir } from './config.ts';

export class AgentRegistry {
  private dirs: AgentDir[];

  constructor() {
    this.dirs = loadAgentDirs();
  }

  all(): AgentDir[] {
    return this.dirs;
  }

  statusDirs(): string[] {
    return this.dirs.map((d) => d.statusDir);
  }

  nameForDir(dir: string): string | null {
    return this.dirs.find((d) => d.statusDir === dir)?.name ?? null;
  }

  reload(): void {
    this.dirs = loadAgentDirs();
  }
}
