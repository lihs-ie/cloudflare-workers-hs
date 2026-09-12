/** Retain Vitest's Istanbul instrumentation while measuring authored test code. */
import istanbul from "@vitest/coverage-istanbul";

export function includeTestFiles(provider) {
  const initialize = provider.initialize.bind(provider);
  provider.initialize = async (context) => {
    await initialize(context);
    const options = provider.resolveOptions();
    // Vitest appends these globs to coverage exclusions unconditionally. Remove
    // only test discovery globs; retain node_modules, config and explicit excludes.
    options.exclude = options.exclude.filter(
      (pattern) => !context.config.include.includes(pattern),
    );
  };
  return provider;
}

export default {
  ...istanbul,
  async getProvider() {
    // Native Node loading preserves Babel CJS interop; the Vite module
    // evaluator must not inline the provider and its compiler dependencies.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { IstanbulCoverageProvider } = require("@vitest/coverage-istanbul/dist/provider.js");
    return includeTestFiles(new IstanbulCoverageProvider());
  },
};
