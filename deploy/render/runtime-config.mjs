const GEMINI_PROVIDER = "gemini.flash";
const GEMINI_MODEL = "gemini-3.6-flash";

function replaceProviderBlock(config) {
  const geminiBlock = `[providers.models.gemini.flash]\nmodel = "${GEMINI_MODEL}"`;
  const openAiBlock =
    /\[providers\.models\.openai\.coding\]\n[\s\S]*?(?=\n\[|$)/;
  const existingGeminiBlock =
    /\[providers\.models\.gemini\.flash\]\n[\s\S]*?(?=\n\[|$)/;

  if (openAiBlock.test(config)) {
    return config.replace(openAiBlock, geminiBlock);
  }
  if (existingGeminiBlock.test(config)) {
    return config.replace(existingGeminiBlock, geminiBlock);
  }
  throw new Error("The configured model provider block was not found.");
}

export function withGeminiFlash(config) {
  let transformed = replaceProviderBlock(config);
  let agentCount = 0;
  transformed = transformed.replace(
    /^(model_provider\s*=\s*)"openai\.coding"$/gm,
    (_match, prefix) => {
      agentCount += 1;
      return `${prefix}"${GEMINI_PROVIDER}"`;
    },
  );

  const configuredGeminiAgents = transformed.match(
    /^model_provider\s*=\s*"gemini\.flash"$/gm,
  )?.length;
  if (agentCount !== 2 && configuredGeminiAgents !== 2) {
    throw new Error(
      "Expected exactly the guardian and payer agents to use Gemini Flash.",
    );
  }
  if (
    transformed.includes("requires_openai_auth") ||
    transformed.includes('model_provider = "openai.coding"')
  ) {
    throw new Error("OpenAI authentication remained in the runtime config.");
  }
  return transformed;
}

export function assertGeminiApiKey(value) {
  if (typeof value !== "string" || value.trim().length < 20) {
    throw new Error("GEMINI_API_KEY is required for the payment agents.");
  }
}

