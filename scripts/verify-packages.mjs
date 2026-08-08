import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDirectories = ['ai', 'openai', 'testing'].map((name) => `packages/${name}`);

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ai-ts-package-check-'));

try {
  for (const packageDirectory of packageDirectories) {
    const existingTarballs = new Set(readdirSync(temporaryDirectory));
    run(
      'pnpm',
      ['--dir', packageDirectory, 'pack', '--pack-destination', temporaryDirectory, '--json'],
      { stdio: 'ignore' },
    );
    const newTarballs = readdirSync(temporaryDirectory).filter(
      (filename) => filename.endsWith('.tgz') && !existingTarballs.has(filename),
    );
    if (newTarballs.length !== 1) {
      throw new Error(`pnpm did not report a tarball for ${packageDirectory}.`);
    }
    const tarball = join(temporaryDirectory, newTarballs[0]);

    run('pnpm', ['exec', 'publint', 'run', tarball, '--pack=false', '--strict'], {
      stdio: 'inherit',
    });
    run('pnpm', ['exec', 'attw', tarball, '--profile', 'esm-only'], {
      stdio: 'inherit',
    });
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

function run(command, arguments_, options) {
  try {
    execFileSync(command, arguments_, options);
  } catch (error) {
    if (error?.code === 'EPERM' && error.status === 0) {
      return;
    }
    throw error;
  }
}
