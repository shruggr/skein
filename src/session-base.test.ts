import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionBase } from "./session-base.ts";

test("sessionBase: the skein a URL is for — its origin, plus a leading /@<handle>; the rest is a route", () => {
  assert.equal(sessionBase("https://alpha.host"), "https://alpha.host");
  assert.equal(sessionBase("https://alpha.host/"), "https://alpha.host");
  assert.equal(sessionBase("https://host/@alpha"), "https://host/@alpha");
  assert.equal(sessionBase("https://host/@alpha/"), "https://host/@alpha");
  assert.equal(sessionBase("https://host/messagebox"), "https://host");
  assert.equal(sessionBase("https://host/@alpha/messagebox"), "https://host/@alpha");
  assert.equal(sessionBase("http://127.0.0.1:8100/@alpha/messagebox/x"), "http://127.0.0.1:8100/@alpha");
  assert.equal(sessionBase(new URL("https://accounts.testnet.1sat.app/messagebox")), "https://accounts.testnet.1sat.app");
});
