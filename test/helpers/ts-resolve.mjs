/**
 * Lets a child process run the TypeScript sources under `src/` as they are.
 *
 * Node strips the types by itself. What it cannot know is that these sources import each other with
 * the `.js` suffix their COMPILED form has (`moduleResolution: NodeNext`), so `./git.js` names a
 * file that only exists in `dist/`. This hook retries a relative specifier that failed to resolve
 * with `.ts` in place of `.js`, and touches nothing else.
 *
 * Loaded with `node --import`. It exists for the tests that need a second PROCESS over the same
 * vault — the one thing a test inside a single vitest worker cannot stage.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('.') || specifier.startsWith('file:');
      if (relative && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
