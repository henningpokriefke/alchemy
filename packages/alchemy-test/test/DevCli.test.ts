import { describe, expect, test } from "bun:test";
import { parseOutputUrl } from "../src/DevCli.ts";

describe("parseOutputUrl", () => {
  test("parses aligned and legacy stack output formats", () => {
    expect(
      parseOutputUrl("  api      http://api.localhost:1234/\n", "api"),
    ).toBe("http://api.localhost:1234/");
    expect(parseOutputUrl('api: "https://example.com/path"\n', "api")).toBe(
      "https://example.com/path",
    );
  });

  test("matches exact keys and waits for a complete output line", () => {
    expect(
      parseOutputUrl("otherApi http://wrong.example/\n", "api"),
    ).toBeUndefined();
    expect(
      parseOutputUrl("api http://partial.example/", "api"),
    ).toBeUndefined();
  });
});
