import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const destination = path.join(projectRoot, "deploy/render/.secrets");

async function copyRequired(source, filename) {
  const destinationPath = path.join(destination, filename);
  await copyFile(path.join(projectRoot, source), destinationPath);
  await chmod(destinationPath, 0o600);
}

await mkdir(destination, { recursive: true, mode: 0o700 });

const localConfig = await readFile(
  path.join(projectRoot, ".zeroclaw-dev/config.toml"),
  "utf8",
);
const deploymentConfig = localConfig
  .replace(/^sops_dir\s*=.*$/m, 'sops_dir = "/app/zeroclaw/sops"')
  .replace(/^plugins_dir\s*=.*$/m, 'plugins_dir = "/app/release/plugins"')
  .replace(
    /^vendor_policy_url\s*=.*$/m,
    'vendor_policy_url = "http://127.0.0.1:3000/api/safespend/vendor-policy/active"',
  );
if (
  deploymentConfig.includes("/Users/") ||
  deploymentConfig === localConfig ||
  !deploymentConfig.includes('plugins_dir = "/app/release/plugins"')
) {
  throw new Error("Could not produce a portable ZeroClaw config.");
}
await writeFile(
  path.join(destination, "zeroclaw-config.toml"),
  deploymentConfig,
  {
    encoding: "utf8",
    mode: 0o600,
  },
);

await copyRequired(".zeroclaw-dev/auth-profiles.json", "auth-profiles.json");
await copyRequired(".zeroclaw-dev/.secret_key", "zeroclaw-secret-key");
await copyRequired(
  ".dev/devnet-payment-config.json",
  "devnet-payment-config.json",
);
await copyRequired("dashboard/.safespend/gateway-token", "gateway-token");

const policyDirectory = path.join(
  projectRoot,
  "dashboard/.safespend/vendor-policies",
);
const policyFiles = (await readdir(policyDirectory))
  .filter(
    (filename) =>
      /^(active|v\d{6})\.json$/.test(filename) || filename === "audit.jsonl",
  )
  .sort();
if (!policyFiles.includes("active.json"))
  throw new Error("No active founder-signed policy found.");
const files = Object.fromEntries(
  await Promise.all(
    policyFiles.map(async (filename) => [
      filename,
      await readFile(path.join(policyDirectory, filename), "utf8"),
    ]),
  ),
);
await writeFile(
  path.join(destination, "vendor-policy-seed.json"),
  `${JSON.stringify({ schema: "safespend-render-policy-seed-v1", files }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const proxyTokenPath = path.join(destination, "frontend-proxy-token.txt");
try {
  await readFile(proxyTokenPath, "utf8");
} catch {
  await writeFile(proxyTokenPath, `${randomBytes(32).toString("hex")}\n`, {
    mode: 0o600,
  });
}
const passwordPath = path.join(destination, "dashboard-password.txt");
try {
  await readFile(passwordPath, "utf8");
} catch {
  await writeFile(passwordPath, `${randomBytes(24).toString("base64url")}\n`, {
    mode: 0o600,
  });
}

console.log(`Prepared 8 deployment files in ${destination}.`);
console.log(
  `The policy seed contains ${policyFiles.length} immutable policy/audit files.`,
);
console.log("No founder wallet key was read or copied.");
