import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const TOKEN = "t".repeat(64);
const PASSWORD = "founder-password-long-enough";

function withHostingEnvironment(run: () => Promise<void>) {
  const previous = {
    origin: process.env.SAFESPEND_BACKEND_ORIGIN,
    token: process.env.SAFESPEND_BACKEND_TOKEN,
    user: process.env.SAFESPEND_DASHBOARD_USER,
    password: process.env.SAFESPEND_DASHBOARD_PASSWORD,
  };
  process.env.SAFESPEND_BACKEND_ORIGIN = "https://runtime.example";
  process.env.SAFESPEND_BACKEND_TOKEN = TOKEN;
  process.env.SAFESPEND_DASHBOARD_USER = "founder";
  process.env.SAFESPEND_DASHBOARD_PASSWORD = PASSWORD;
  return run().finally(() => {
    if (previous.origin === undefined) delete process.env.SAFESPEND_BACKEND_ORIGIN;
    else process.env.SAFESPEND_BACKEND_ORIGIN = previous.origin;
    if (previous.token === undefined) delete process.env.SAFESPEND_BACKEND_TOKEN;
    else process.env.SAFESPEND_BACKEND_TOKEN = previous.token;
    if (previous.user === undefined) delete process.env.SAFESPEND_DASHBOARD_USER;
    else process.env.SAFESPEND_DASHBOARD_USER = previous.user;
    if (previous.password === undefined) delete process.env.SAFESPEND_DASHBOARD_PASSWORD;
    else process.env.SAFESPEND_DASHBOARD_PASSWORD = previous.password;
  });
}

test("authenticates the founder before rewriting to the hosted route", () =>
  withHostingEnvironment(async () => {
    const basic = Buffer.from(`founder:${PASSWORD}`).toString("base64");
    const response = await proxy(
      new NextRequest("https://dashboard.example/api/safespend/connection", {
        headers: { Authorization: `Basic ${basic}` },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-middleware-rewrite"),
      "https://dashboard.example/api/safespend-hosted/connection",
    );
  }));

test("does not require founder Basic auth again after the internal rewrite", () =>
  withHostingEnvironment(async () => {
    const response = await proxy(
      new NextRequest("https://dashboard.example/api/safespend-hosted/connection", {
        headers: { "x-safespend-internal-token": TOKEN },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  }));

test("continues to reject an unauthenticated public dashboard request", () =>
  withHostingEnvironment(async () => {
    const response = await proxy(
      new NextRequest("https://dashboard.example/api/safespend/connection"),
    );

    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get("www-authenticate"),
      'Basic realm="SafeSpend founder", charset="UTF-8"',
    );
  }));
