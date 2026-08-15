import assert from "node:assert/strict";
import test from "node:test";
import { assertGeminiApiKey, withGeminiFlash } from "./runtime-config.mjs";

const openAiConfig = `schema_version = 3

[providers.models.openai.coding]
model = "gpt-5.4"
wire_api = "responses"
requires_openai_auth = true

[agents.guardian]
model_provider = "openai.coding"

[agents.payer]
model_provider = "openai.coding"
`;

test("switches both payment agents from OpenAI OAuth to Gemini Flash", () => {
  const result = withGeminiFlash(openAiConfig);

  assert.match(result, /\[providers\.models\.gemini\.flash\]/);
  assert.match(result, /model = "gemini-3\.6-flash"/);
  assert.equal(result.match(/model_provider = "gemini\.flash"/g)?.length, 2);
  assert.doesNotMatch(result, /openai\.coding|requires_openai_auth/);
});

test("is idempotent for an already transformed config", () => {
  const once = withGeminiFlash(openAiConfig);
  assert.equal(withGeminiFlash(once), once);
});

test("refuses a config that does not identify both payment agents", () => {
  assert.throws(
    () =>
      withGeminiFlash(
        openAiConfig.replace(
          'model_provider = "openai.coding"',
          'model_provider = "another.provider"',
        ),
      ),
    /guardian and payer/,
  );
});

test("requires a non-empty Gemini API key", () => {
  assert.throws(() => assertGeminiApiKey("short"), /GEMINI_API_KEY/);
  assert.doesNotThrow(() => assertGeminiApiKey("a".repeat(32)));
});

