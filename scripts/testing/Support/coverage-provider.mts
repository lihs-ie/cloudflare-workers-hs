import path from 'node:path';
import istanbul from '@vitest/coverage-istanbul';
import type { CoverageProvider, Vitest } from 'vitest/node';

interface TestCoverageProvider {
  initialize(context: Vitest): void | Promise<void>;
  resolveOptions(): { exclude: string[] };
}

export function authoredCoverageExclusions(
  root: string,
  include: readonly string[],
  setupFiles: readonly string[],
  excluded: readonly string[],
): string[] {
  const authored = new Set(include);
  for (const file of setupFiles) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    authored.add(relative);
    authored.add(`**/${relative}`);
    authored.add(file);
  }

  return excluded.filter((pattern) => !authored.has(pattern));
}

export function includeTestFiles<T extends TestCoverageProvider>(provider: T): T {
  const initialize = provider.initialize.bind(provider);
  provider.initialize = async (context): Promise<void> => {
    await initialize(context);
    const options = provider.resolveOptions();
    options.exclude = authoredCoverageExclusions(
      context.config.root,
      context.config.include,
      context.config.setupFiles,
      options.exclude,
    );
  };

  return provider;
}

export default {
  ...istanbul,
  async getProvider(): Promise<CoverageProvider> {
    return includeTestFiles(await istanbul.getProvider());
  },
};
