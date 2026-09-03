import { verifyWebhookSignature } from "@/GitHub/Actions/crypto.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NodeCrypto from "node:crypto";

const sign = (secret: string, body: string): string => {
  const hmac = NodeCrypto.createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
};

describe("verifyWebhookSignature", () => {
  it.effect("accepts a valid signature", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ action: "queued", zen: "test" });
      const valid = yield* verifyWebhookSignature({
        secret: Redacted.make("my-secret"),
        rawBody: body,
        signatureHeader: sign("my-secret", body),
      });
      expect(valid).toBe(true);
    }),
  );

  it.effect("accepts a plain string secret and Uint8Array bodies", () =>
    Effect.gen(function* () {
      const body = new TextEncoder().encode("raw-bytes");
      const hmac = NodeCrypto.createHmac("sha256", "s3cr3t");
      hmac.update(body);
      const valid = yield* verifyWebhookSignature({
        secret: "s3cr3t",
        rawBody: body,
        signatureHeader: `sha256=${hmac.digest("hex")}`,
      });
      expect(valid).toBe(true);
    }),
  );

  it.effect("rejects a wrong signature without failing", () =>
    Effect.gen(function* () {
      const valid = yield* verifyWebhookSignature({
        secret: "my-secret",
        rawBody: "body",
        signatureHeader: sign("other-secret", "body"),
      });
      expect(valid).toBe(false);
    }),
  );

  it.effect("rejects tampered bodies", () =>
    Effect.gen(function* () {
      const valid = yield* verifyWebhookSignature({
        secret: "my-secret",
        rawBody: '{"action":"queued"}',
        signatureHeader: sign("my-secret", '{"action": "queued"}'),
      });
      expect(valid).toBe(false);
    }),
  );

  it.effect("returns false for missing or malformed headers", () =>
    Effect.gen(function* () {
      expect(
        yield* verifyWebhookSignature({
          secret: "s",
          rawBody: "b",
          signatureHeader: undefined,
        }),
      ).toBe(false);
      expect(
        yield* verifyWebhookSignature({
          secret: "s",
          rawBody: "b",
          signatureHeader: "md5=deadbeef",
        }),
      ).toBe(false);
    }),
  );
});
