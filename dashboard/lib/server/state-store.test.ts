import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteState,
  readRemoteState,
  usesRemoteState,
  writeRemoteState,
} from "./state-store-client";

const urlVariable = "SAFESPEND_SUPABASE_URL";
const keyVariable = "SAFESPEND_SUPABASE_SERVICE_ROLE_KEY";

async function withRemoteState(
  fetchImplementation: typeof fetch,
  callback: () => Promise<void>,
  key = "s".repeat(48),
) {
  const previousUrl = process.env[urlVariable];
  const previousKey = process.env[keyVariable];
  const previousFetch = globalThis.fetch;
  process.env[urlVariable] = "https://project.supabase.co";
  process.env[keyVariable] = key;
  globalThis.fetch = fetchImplementation;
  try {
    await callback();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env[urlVariable];
    else process.env[urlVariable] = previousUrl;
    if (previousKey === undefined) delete process.env[keyVariable];
    else process.env[keyVariable] = previousKey;
  }
}

test("reads server-only durable state with authenticated no-store requests", async () => {
  await withRemoteState(
    (async (input, init) => {
      assert.match(String(input), /state_key=eq\.payments%2Frequests/);
      assert.equal(new Headers(init?.headers).get("apikey"), "s".repeat(48));
      assert.equal(init?.cache, "no-store");
      return Response.json([{ state_value: { version: 1, payments: [] } }]);
    }) as typeof fetch,
    async () => {
      assert.equal(usesRemoteState(), true);
      assert.deepEqual(await readRemoteState("payments/requests"), {
        version: 1,
        payments: [],
      });
    },
  );
});

test("upserts durable state and treats create conflicts as an existing record", async () => {
  const requests: RequestInit[] = [];
  await withRemoteState(
    (async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: requests.length === 1 ? 201 : 409 });
    }) as typeof fetch,
    async () => {
      assert.equal(await writeRemoteState("vendor-policies/active", { version: 2 }), true);
      assert.equal(await createRemoteState("vendor-proposals/test", {}), false);
    },
  );
  assert.equal(requests[0]?.method, "POST");
  assert.match(String(requests[0]?.body), /vendor-policies\/active/);
});

test("uses a new Supabase secret key only in the apikey header", async () => {
  const secret = `sb_secret_${"x".repeat(40)}`;
  await withRemoteState(
    (async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), secret);
      assert.equal(headers.get("authorization"), null);
      return Response.json([]);
    }) as typeof fetch,
    async () => {
      assert.equal(await readRemoteState("payments/requests"), null);
    },
    secret,
  );
});

test("fails closed when only one durable-state credential is configured", () => {
  const previousUrl = process.env[urlVariable];
  const previousKey = process.env[keyVariable];
  process.env[urlVariable] = "https://project.supabase.co";
  delete process.env[keyVariable];
  try {
    assert.throws(() => usesRemoteState(), /credentials are incomplete/);
  } finally {
    if (previousUrl === undefined) delete process.env[urlVariable];
    else process.env[urlVariable] = previousUrl;
    if (previousKey === undefined) delete process.env[keyVariable];
    else process.env[keyVariable] = previousKey;
  }
});
