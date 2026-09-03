import { createAppJwt } from "@/GitHub/Actions/GitHubApp.ts";
import {
  jitParameterName,
  routeParameterName,
  runnerNameFor,
} from "@/GitHub/Actions/shared.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NodeCrypto from "node:crypto";

describe("shared naming", () => {
  it("builds route parameter names", () => {
    expect(
      routeParameterName("/alchemy/github-runners/routes", "alchemy-ci-4x"),
    ).toBe("/alchemy/github-runners/routes/alchemy-ci-4x");
    expect(
      routeParameterName("/alchemy/github-runners/routes/", "alchemy-ci-4x"),
    ).toBe("/alchemy/github-runners/routes/alchemy-ci-4x");
  });

  it("builds JIT parameter names", () => {
    expect(
      jitParameterName("/alchemy/github-runners/jit", "gh-alchemy-ci-4x-42"),
    ).toBe("/alchemy/github-runners/jit/gh-alchemy-ci-4x-42");
  });

  it("derives collision-free runner names and sanitizes labels", () => {
    expect(runnerNameFor("alchemy-ci-4x", 42)).toBe("gh-alchemy-ci-4x-42");
    expect(runnerNameFor("my pool!", 7)).toBe("gh-my-pool--7");
  });
});

describe("createAppJwt", () => {
  it.effect("mints a verifiable RS256 JWT", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const pem = privateKey.export({ type: "pkcs1", format: "pem" });
      const jwt = yield* createAppJwt(
        { appId: "12345", privateKey: Redacted.make(pem) },
        1_700_000_000,
      );
      const [header, payload, signature] = jwt.split(".");
      expect(
        JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
      ).toEqual({ alg: "RS256", typ: "JWT" });
      expect(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      ).toEqual({
        iat: 1_700_000_000 - 60,
        exp: 1_700_000_000 + 600,
        iss: "12345",
      });
      const verifier = NodeCrypto.createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      verifier.end();
      expect(
        verifier.verify(publicKey, Buffer.from(signature, "base64url")),
      ).toBe(true);
    }),
  );
});
