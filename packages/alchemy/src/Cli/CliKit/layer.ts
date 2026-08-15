import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isNonInteractive } from "../../Util/interactive.ts";
import { CliKit } from "./CliKit.ts";
import { colorsEnabled, unicodeEnabled } from "./terminal.ts";
import type { CliKitCapabilities, CliKitOptions } from "./types.ts";

const resolveCapabilities = (options: CliKitOptions): CliKitCapabilities => {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const input =
    options.input ??
    (stdin.isTTY === true && stdout.isTTY === true && !isNonInteractive());
  return {
    input,
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
    // Delegate to the shared decisions in terminal.ts so raw string helpers
    // and the component renderer can never disagree about color/unicode.
    colors: options.colors ?? colorsEnabled(stdout),
    unicode: options.unicode ?? unicodeEnabled(),
  };
};

/** Provides one terminal runtime for the enclosing scope. */
export const layer = (options: CliKitOptions = {}) =>
  Layer.effect(
    CliKit,
    Effect.acquireRelease(
      Effect.promise(async () => {
        const capabilities = resolveCapabilities(options);
        const { makeRuntime } = await import("./InkRuntime.tsx");
        return makeRuntime(options, capabilities);
      }),
      ({ dispose }) => Effect.promise(dispose),
    ).pipe(Effect.map(({ service }) => service)),
  );
