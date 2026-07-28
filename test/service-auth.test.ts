import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceAuthHeaderFor } from "../src/serviceAuth.js";

test("service tokens are bound to trusted destination origins", () => {
  const options = {
    configuredOrigins: ["http://127.0.0.1:8321"],
    defaultOrigin: "http://127.0.0.1:8321",
    tokenName: "ACME_PROJECTS_TOKEN",
  };
  assert.deepEqual(
    serviceAuthHeaderFor("http://127.0.0.1:8321/api/webhooks/issues", "svc_secret", options),
    { Authorization: "Bearer svc_secret" },
  );
  assert.throws(
    () => serviceAuthHeaderFor("https://attacker.example/hook", "svc_secret", options),
    /untrusted origin/,
  );
  assert.deepEqual(serviceAuthHeaderFor("https://replaceable.example/hook", undefined, options), {});
});
