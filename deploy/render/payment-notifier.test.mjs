import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTelegramDelivery,
  projectSubmittedPayments,
} from "./payment-notifier.mjs";

const signature =
  "5UP7B6hfNqjUHtn1JaFGxbESvPb6Qc2NLZA1fWhtHnTniFDb6D39B5wzFt7c9Wy4wCxUTsXMNtP5sLMNqFzD9g7Q";

test("projects an exact submitted payment from the durable SOP run", () => {
  const rows = [
    {
      json: JSON.stringify({
        run: {
          run_id: "run-1786385225527769000-0003",
          sop_name: "approved-expense",
          step_results: [
            {
              step_number: 2,
              output: JSON.stringify({
                status: "submitted",
                signature,
                vendor_id: "hosting",
                amount_base_units: 12_000_000,
              }),
            },
          ],
        },
      }),
    },
  ];
  assert.deepEqual(projectSubmittedPayments(rows), [
    {
      signature,
      vendorId: "hosting",
      amountBaseUnits: "12000000",
      runId: "run-1786385225527769000-0003",
    },
  ]);
});

test("ignores malformed, non-payment, and non-submitted audit rows", () => {
  assert.deepEqual(
    projectSubmittedPayments([
      { json: "{" },
      {
        json: JSON.stringify({
          run: {
            run_id: "run-1786385225527769000-0001",
            sop_name: "treasury-monitor",
            step_results: [],
          },
        }),
      },
      {
        json: JSON.stringify({
          run: {
            run_id: "run-1786385225527769000-0002",
            sop_name: "approved-expense",
            step_results: [{ step_number: 2, output: '{"status":"failed"}' }],
          },
        }),
      },
    ]),
    [],
  );
});

test("reads the routed chat without handling the encrypted bot token", () => {
  assert.deepEqual(
    parseTelegramDelivery(`
[channels.telegram.guardian]
enabled = true
bot_token = "enc:v1:ciphertext"

[sop.approval.policies.founder_telegram]
request_route = "telegram.guardian:5504043269"
`),
    { chatId: "5504043269" },
  );
});
