import * as Effect from "effect/Effect";
import { unpackEnvValue } from "../../RuntimeContext.ts";

/**
 * Runtime environment access for the runner control-plane Lambdas.
 *
 * Handler implementations are static modules shared by every pool: the
 * only per-pool/per-app configuration channel into Lambda execution is
 * the function's environment (written at deploy time from resolved
 * Outputs by the composites). These helpers read it back — including
 * `Redacted`-packed secrets — without ever touching deploy-time state.
 *
 * `process.env` is read inside `Effect.sync` only from runtime code
 * paths (event listeners); deploy-time code in the same modules consumes
 * deploy-config context tags instead and never calls these helpers.
 */

/**
 * Read one variable, unpacking framework-packed values (`Redacted`
 * markers, JSON). Empty strings count as missing.
 */
export const readEnv = (key: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    const unpacked = unpackEnvValue<string>(process.env[key]);
    return unpacked === "" ? undefined : unpacked;
  });

/**
 * Read one JSON-encoded variable (arrays/objects written via
 * `JSON.stringify` at deploy time). Fails on corrupt JSON — a broken
 * deployment should be loud, not silently unconfigured.
 */
export const readJsonEnv = <T>(
  key: string,
): Effect.Effect<T | undefined, Error> =>
  Effect.flatMap(readEnv(key), (raw) => {
    if (raw === undefined) {
      return Effect.succeed(undefined);
    }
    try {
      return Effect.succeed(JSON.parse(raw) as T);
    } catch {
      return Effect.fail(new Error(`Invalid JSON in env ${key}`));
    }
  });

/**
 * Read one variable without failing when it is missing.
 */
export const optionalEnv = (key: string): Effect.Effect<string | undefined> =>
  readEnv(key);

/**
 * Require one variable to be present.
 */
export const requiredEnv = (
  owner: string,
  key: string,
): Effect.Effect<string, Error> =>
  Effect.flatMap(readEnv(key), (value) =>
    value === undefined
      ? Effect.fail(new Error(`Missing required ${owner} env ${key}`))
      : Effect.succeed(value),
  );

/**
 * Require one JSON-encoded variable to be present.
 */
export const requiredJsonEnv = <T>(
  owner: string,
  key: string,
): Effect.Effect<T, Error> =>
  Effect.flatMap(readJsonEnv<T>(key), (value) =>
    value === undefined
      ? Effect.fail(new Error(`Missing required ${owner} env ${key}`))
      : Effect.succeed(value),
  );
