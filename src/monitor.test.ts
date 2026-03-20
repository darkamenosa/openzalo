import assert from "node:assert/strict";
import test from "node:test";
import { OPENZCA_LISTEN_ARGS } from "./listen-args.ts";

test("openzca listen args use supervised raw mode", () => {
  assert.deepEqual(OPENZCA_LISTEN_ARGS, ["listen", "--raw", "--supervised"]);
  assert.equal(OPENZCA_LISTEN_ARGS.includes("--keep-alive"), false);
});
