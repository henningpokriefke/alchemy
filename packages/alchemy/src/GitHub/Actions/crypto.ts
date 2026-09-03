import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw
 * request body.
 *
 * The comparison runs over the exact delivery bytes: callers must pass the
 * unmodified body (no JSON re-serialization — GitHub signs the raw payload
 * and any whitespace change breaks the HMAC).
 *
 * Returns `false` (never fails) for a missing or malformed signature so
 * the webhook handler can answer `401`/`400` without an error channel.
 *
 * **Example:** Verify a delivery
 * ```typescript
 * const valid = yield* verifyWebhookSignature({
 *   secret: Redacted.make("my-secret"),
 *   rawBody: event.body,
 *   signatureHeader: event.headers["x-hub-signature-256"],
 * });
 * if (!valid) {
 *   return { statusCode: 401, body: "invalid signature" };
 * }
 * ```
 */
export const verifyWebhookSignature = (input: {
  readonly secret: Redacted.Redacted<string> | string;
  readonly rawBody: string | Uint8Array;
  readonly signatureHeader: string | undefined;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const header = input.signatureHeader;
    if (!header || !header.startsWith("sha256=")) {
      return false;
    }
    const secret =
      typeof input.secret === "string"
        ? input.secret
        : Redacted.value(input.secret);
    const bodyBytes =
      typeof input.rawBody === "string"
        ? new TextEncoder().encode(input.rawBody)
        : input.rawBody;

    const key = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (!key) {
      return false;
    }
    const signature = yield* Effect.tryPromise(() =>
      crypto.subtle.sign("HMAC", key, bodyBytes as BufferSource),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (!signature) {
      return false;
    }
    const expected = `sha256=${toHex(new Uint8Array(signature))}`;
    return timingSafeEqualString(expected, header);
  });

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const timingSafeEqualString = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
};
