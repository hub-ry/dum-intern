// The note CLI's parsing boundaries: the environment file is read literally with no shell
// semantics, explicit environment wins, the workshop origin is derived safely, and the pages file
// is validated with the server's own rules before anything would be sent. No network, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, parseEnvFile, payloadFromFile, resolveConfig } from "./notes-cli.ts";

function cliError(exitCode?: number): (err: unknown) => boolean {
  return (err) => err instanceof CliError && (exitCode === undefined || err.exitCode === exitCode);
}

test("the environment file is parsed as literal systemd-style KEY=value lines, never expanded, with only known keys returned", () => {
  const parsed = parseEnvFile([
    "# comment",
    "; another comment",
    "",
    "DUM_WORKSHOP_HOST=0.0.0.0   ",
    "  DUM_WORKSHOP_PORT = 8770",
    "DUM_WORKSHOP_TOKEN='$(whoami) # not a comment'",
    "DUM_WORKSHOP_URL=\"http://hub.local:8770\\\\\" # trailing comment",
    "PATH=/usr/local/bin:/usr/bin",
    "OTHER_SECRET=do-not-return",
    "DUM_WORKSHOP_HOST=127.0.0.1 \\",
    "",
  ].join("\n"));
  assert.deepEqual([...parsed.keys()].sort(), ["DUM_WORKSHOP_HOST", "DUM_WORKSHOP_PORT", "DUM_WORKSHOP_TOKEN", "DUM_WORKSHOP_URL"]);
  assert.equal(parsed.get("DUM_WORKSHOP_HOST"), "127.0.0.1");
  assert.equal(parsed.get("DUM_WORKSHOP_PORT"), "8770");
  assert.equal(parsed.get("DUM_WORKSHOP_TOKEN"), "$(whoami) # not a comment");
  assert.equal(parsed.get("DUM_WORKSHOP_URL"), "http://hub.local:8770\\");
  assert.equal(parsed.has("OTHER_SECRET" as never), false);
  assert.equal(parsed.has("PATH" as never), false);

  assert.equal(parseEnvFile("DUM_WORKSHOP_TOKEN=$HOME/${X}").get("DUM_WORKSHOP_TOKEN"), "$HOME/${X}");
  assert.equal(parseEnvFile("DUM_WORKSHOP_TOKEN=part-one\\\npart-two").get("DUM_WORKSHOP_TOKEN"), "part-onepart-two");
  assert.equal(parseEnvFile("DUM_WORKSHOP_TOKEN=crlf\r\n").get("DUM_WORKSHOP_TOKEN"), "crlf");
  assert.deepEqual([...parseEnvFile("").keys()], []);

  for (const bad of [
    "DUM_WORKSHOP_TOKEN",
    "=value",
    "1BAD=value",
    "DUM-WORKSHOP-TOKEN=value",
    "export DUM_WORKSHOP_TOKEN=value",
    "DUM_WORKSHOP_TOKEN='unterminated",
    "DUM_WORKSHOP_TOKEN=\"unterminated",
    "DUM_WORKSHOP_TOKEN='a' b",
    "DUM_WORKSHOP_TOKEN=it's",
    "DUM_WORKSHOP_TOKEN=say \"hi\"",
    "DUM_WORKSHOP_TOKEN=\"bad \\x escape\"",
    "DUM_WORKSHOP_TOKEN=bell\x07",
    "DUM_WORKSHOP_TOKEN=nul\0",
    "OTHER=fine\nDUM_WORKSHOP_TOKEN",
  ]) {
    assert.throws(() => parseEnvFile(bad), cliError(2), JSON.stringify(bad));
  }
  // A malformed line is reported by number, never by content.
  assert.throws(() => parseEnvFile("ok=1\nsecret-value-here"), (err: unknown) => err instanceof CliError && err.message.includes("line 2") && !err.message.includes("secret-value-here"));
});

test("explicit environment overrides the file, the token is required, and the workshop origin is derived or validated", () => {
  const file = parseEnvFile("DUM_WORKSHOP_TOKEN=from-file\nDUM_WORKSHOP_HOST=10.0.0.5\nDUM_WORKSHOP_PORT=9000");
  assert.deepEqual(resolveConfig({}, file), { baseUrl: "http://10.0.0.5:9000", token: "from-file" });
  assert.deepEqual(resolveConfig({ DUM_WORKSHOP_TOKEN: "from-env", DUM_WORKSHOP_PORT: "9001" }, file), { baseUrl: "http://10.0.0.5:9001", token: "from-env" });

  assert.throws(() => resolveConfig({}, new Map()), cliError(2));
  assert.throws(() => resolveConfig({ DUM_WORKSHOP_TOKEN: "   " }, new Map()), cliError(2));
  assert.throws(() => resolveConfig({ DUM_WORKSHOP_TOKEN: "has space" }, new Map()), cliError(2));

  const t = { DUM_WORKSHOP_TOKEN: "tok-tok-tok" };
  assert.equal(resolveConfig(t, new Map()).baseUrl, "http://127.0.0.1:8770");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_HOST: "0.0.0.0" }, new Map()).baseUrl, "http://127.0.0.1:8770");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_HOST: "" }, new Map()).baseUrl, "http://127.0.0.1:8770");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_HOST: "::" }, new Map()).baseUrl, "http://[::1]:8770");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_HOST: "fd00::1", DUM_WORKSHOP_PORT: "8080" }, new Map()).baseUrl, "http://[fd00::1]:8080");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_HOST: "Hub.Local" }, new Map()).baseUrl, "http://hub.local:8770");
  for (const bad of ["not a host", "hub/local", "hub?x", "-"]) {
    assert.throws(() => resolveConfig({ ...t, DUM_WORKSHOP_HOST: bad }, new Map()), cliError(2), bad);
  }
  for (const bad of ["0", "65536", "abc", "80 80", "-1"]) {
    assert.throws(() => resolveConfig({ ...t, DUM_WORKSHOP_PORT: bad }, new Map()), cliError(2), bad);
  }

  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_URL: "https://workshop.example.net/" }, new Map()).baseUrl, "https://workshop.example.net");
  assert.equal(resolveConfig({ ...t, DUM_WORKSHOP_URL: "http://10.0.0.5:8770", DUM_WORKSHOP_HOST: "ignored" }, new Map()).baseUrl, "http://10.0.0.5:8770");
  for (const bad of ["ftp://x.example/", "http://user:pw@x.example/", "http://user@x.example/", "http://x.example/api", "http://x.example/?q=1", "http://x.example/#f", "x.example:8770", "javascript:alert(1)"]) {
    assert.throws(() => resolveConfig({ ...t, DUM_WORKSHOP_URL: bad }, new Map()), cliError(2), bad);
  }
  // Configuration errors never quote the token.
  try {
    resolveConfig({ DUM_WORKSHOP_TOKEN: "very-secret-token-value", DUM_WORKSHOP_URL: "ftp://x.example/" }, new Map());
    assert.fail("expected a CliError");
  } catch (err) {
    assert.ok(err instanceof CliError);
    assert.equal(err.message.includes("very-secret-token-value"), false);
  }
});

test("the pages file is a {pages, links} object, validated with the server's rules; title and topic are flags", () => {
  const pages = [{ heading: "One", text: "first" }, { heading: "Two", text: "second", code: "x = 1" }];
  assert.throws(() => payloadFromFile(JSON.stringify(pages), "T", "topic"), cliError(2));
  assert.deepEqual(payloadFromFile(JSON.stringify({ pages }), "T", "topic"), { title: "T", topic: "topic", pages });
  const withLinks = payloadFromFile(JSON.stringify({ pages, links: [{ label: "l", url: "https://example.com/" }] }), "T", "topic");
  assert.deepEqual(withLinks.links, [{ label: "l", url: "https://example.com/" }]);
  assert.equal("links" in payloadFromFile(JSON.stringify({ pages }), "T", "topic"), false);

  assert.throws(() => payloadFromFile("not json", "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile("\"string\"", "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile("null", "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages, title: "in file" }), "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages, context: "private" }), "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ links: [] }), "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile("[]", "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages: [{ heading: "h", text: "t", extra: 1 }] }), "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages }), "", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages }), "T", "line\nbreak"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages, links: [{ label: "l", url: "http://example.com/" }] }), "T", "topic"), cliError(2));
  assert.throws(() => payloadFromFile(JSON.stringify({ pages: [{ heading: "h", text: "x".repeat(40_000) }] }), "T", "topic"), cliError(2));
});
