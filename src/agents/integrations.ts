// Registry-driven integration model (Phase 3). Each supported agent harness
// (claude / codex / pi) is described by one IntegrationDescriptor that WRAPS the
// existing per-agent install/uninstall logic — no behavioral rewrite, just a
// single table the CLI dispatches through instead of hand-rolled
// `if (arg === 'codex')` branching. Adding a harness becomes a data edit here.

import { runInstall, runUninstall } from '../cli/install.ts';
import { runInstallCodex, runUninstallCodex } from '../cli/install-codex.ts';
import { runInstallPi, runUninstallPi } from '../cli/install-pi.ts';

export interface IntegrationDescriptor {
  // Stable CLI key: `fleet install <key>` / `fleet uninstall <key>`. Also the
  // detection manifest key (see manifestKey) for every current integration.
  key: string;
  // Human label for help + error text.
  label: string;
  // The built-in detection manifest agent this integration wires up. Kept
  // explicit (rather than assumed == key) so a future integration can register
  // under one CLI key while sourcing a different manifest.
  manifestKey: string;
  // True for the integration a bare `fleet install` (no argument) selects.
  // Exactly one descriptor is the default (claude), preserving `install` ==
  // `install claude`.
  isDefault: boolean;
  // Thin wrappers over the existing, unchanged install/uninstall entry points.
  install: () => number;
  uninstall: () => number;
}

// Order is the documented listing order (help output, error messages).
export const INTEGRATIONS: readonly IntegrationDescriptor[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    manifestKey: 'claude',
    isDefault: true,
    install: runInstall,
    uninstall: runUninstall,
  },
  {
    key: 'codex',
    label: 'Codex',
    manifestKey: 'codex',
    isDefault: false,
    install: runInstallCodex,
    uninstall: runUninstallCodex,
  },
  {
    key: 'pi',
    label: 'pi',
    manifestKey: 'pi',
    isDefault: false,
    install: runInstallPi,
    uninstall: runUninstallPi,
  },
];

export function integrationKeys(): string[] {
  return INTEGRATIONS.map((i) => i.key);
}

export function defaultIntegration(): IntegrationDescriptor {
  const def = INTEGRATIONS.find((i) => i.isDefault);
  if (!def) throw new Error('no default integration registered');
  return def;
}

// Resolve a CLI argument to an integration. `undefined` (bare `fleet install`)
// resolves to the default (claude). An unknown key resolves to null so the
// caller can reject it explicitly rather than silently falling back.
export function resolveIntegration(key: string | undefined): IntegrationDescriptor | null {
  if (key === undefined) return defaultIntegration();
  return INTEGRATIONS.find((i) => i.key === key) ?? null;
}

function unknownMessage(verb: string, key: string): string {
  return `Unknown integration '${key}'. Try: ${INTEGRATIONS.map((i) => `fleet ${verb} ${i.key}`).join(', ')}\n`;
}

// CLI entry points. `arg` is the raw sub-argument (args[1]); a flag (leading
// `--`) or absence both select the default, preserving bare-install behavior.
export function runIntegrationInstall(arg: string | undefined): number {
  const key = arg && !arg.startsWith('-') ? arg : undefined;
  const integration = resolveIntegration(key);
  if (!integration) {
    process.stderr.write(unknownMessage('install', key!));
    return 1;
  }
  return integration.install();
}

export function runIntegrationUninstall(arg: string | undefined): number {
  const key = arg && !arg.startsWith('-') ? arg : undefined;
  const integration = resolveIntegration(key);
  if (!integration) {
    process.stderr.write(unknownMessage('uninstall', key!));
    return 1;
  }
  return integration.uninstall();
}
