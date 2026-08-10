import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { assertLocalOperatorRequest, LocalAccessError } from "./security";

function request(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

test("allows the existing loopback operator flow", () => {
  assert.doesNotThrow(() =>
    assertLocalOperatorRequest(
      request("http://localhost:3000/api/safespend/bootstrap", {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin",
      }),
    ),
  );
});

test("rejects an unauthenticated remote request", () => {
  assert.throws(
    () =>
      assertLocalOperatorRequest(
        request("https://runtime.example/api/safespend/bootstrap", {
          host: "runtime.example",
        }),
      ),
    LocalAccessError,
  );
});

test("allows the authenticated Vercel server proxy", () => {
  const previous = process.env.SAFESPEND_FRONTEND_PROXY_TOKEN;
  process.env.SAFESPEND_FRONTEND_PROXY_TOKEN = "a".repeat(64);
  try {
    assert.doesNotThrow(() =>
      assertLocalOperatorRequest(
        request("https://runtime.example/api/safespend/bootstrap", {
          host: "runtime.example",
          authorization: `Bearer ${"a".repeat(64)}`,
          "x-safespend-proxy": "vercel",
        }),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.SAFESPEND_FRONTEND_PROXY_TOKEN;
    else process.env.SAFESPEND_FRONTEND_PROXY_TOKEN = previous;
  }
});

test("still requires the founder action header for proxied mutations", () => {
  const previous = process.env.SAFESPEND_FRONTEND_PROXY_TOKEN;
  process.env.SAFESPEND_FRONTEND_PROXY_TOKEN = "b".repeat(64);
  try {
    assert.throws(
      () =>
        assertLocalOperatorRequest(
          request("https://runtime.example/api/safespend/payments", {
            host: "runtime.example",
            authorization: `Bearer ${"b".repeat(64)}`,
            "x-safespend-proxy": "vercel",
          }),
          true,
        ),
      LocalAccessError,
    );
  } finally {
    if (previous === undefined) delete process.env.SAFESPEND_FRONTEND_PROXY_TOKEN;
    else process.env.SAFESPEND_FRONTEND_PROXY_TOKEN = previous;
  }
});
