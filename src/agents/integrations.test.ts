import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  INTEGRATIONS,
  defaultIntegration,
  integrationKeys,
  resolveIntegration,
  runIntegrationInstall,
  runIntegrationUninstall,
} from './integrations.ts';
import { runInstall, runUninstall } from '../cli/install.ts';
import { runInstallCodex, runUninstallCodex } from '../cli/install-codex.ts';
import { runInstallPi, runUninstallPi } from '../cli/install-pi.ts';

let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>> | null = null;

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

describe('integration registry', () => {
  test('registers claude, codex, and pi with stable keys and manifest keys', () => {
    expect(integrationKeys()).toEqual(['claude', 'codex', 'pi']);
    for (const i of INTEGRATIONS) {
      expect(i.manifestKey).toBe(i.key); // current integrations map 1:1
      expect(i.label).toEqual(expect.any(String));
      expect(i.label.length).toBeGreaterThan(0);
    }
  });

  test('claude is the single default (bare install)', () => {
    expect(INTEGRATIONS.filter((i) => i.isDefault).map((i) => i.key)).toEqual(['claude']);
    expect(defaultIntegration().key).toBe('claude');
    expect(resolveIntegration(undefined)!.key).toBe('claude');
  });

  test('descriptors wrap the existing install/uninstall entry points unchanged', () => {
    const claude = resolveIntegration('claude')!;
    expect(claude.install).toBe(runInstall);
    expect(claude.uninstall).toBe(runUninstall);
    const codex = resolveIntegration('codex')!;
    expect(codex.install).toBe(runInstallCodex);
    expect(codex.uninstall).toBe(runUninstallCodex);
    const pi = resolveIntegration('pi')!;
    expect(pi.install).toBe(runInstallPi);
    expect(pi.uninstall).toBe(runUninstallPi);
  });

  test('an unknown key resolves to null', () => {
    expect(resolveIntegration('emacs')).toBeNull();
  });

  test('runIntegrationInstall rejects an unknown key explicitly', () => {
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runIntegrationInstall('emacs')).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    const msg = String(stderrSpy.mock.calls[0]![0]);
    expect(msg).toContain("Unknown integration 'emacs'");
    expect(msg).toContain('fleet install claude');
  });

  test('runIntegrationUninstall rejects an unknown key explicitly', () => {
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runIntegrationUninstall('emacs')).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]![0])).toContain('fleet uninstall pi');
  });

  test('a flag argument selects the default rather than being an unknown key', () => {
    // `--force`-style flags must not be misread as an integration name.
    expect(resolveIntegration(undefined)!.key).toBe('claude');
    // resolveIntegration('-x') is treated as unknown, but the CLI wrappers strip
    // leading-dash args to the default before resolving.
    expect(resolveIntegration('-x')).toBeNull();
  });
});
