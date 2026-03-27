import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CERT_DIR = path.join(ROOT_DIR, ".cert");
const KEY_FILE = path.join(CERT_DIR, "dev-key.pem");
const CERT_FILE = path.join(CERT_DIR, "dev-cert.pem");

function getLanIpAddress() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return null;
}

export function ensureDevCertificate() {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const lanIpAddress = getLanIpAddress();
  const hostnames = new Set(["localhost", os.hostname()]);
  const ipAddresses = new Set(["127.0.0.1"]);

  if (lanIpAddress) {
    ipAddresses.add(lanIpAddress);
  }

  const configFile = path.join(CERT_DIR, "openssl-dev.cnf");
  const altNames = [
    ...Array.from(hostnames).map((value, index) => `DNS.${index + 1} = ${value}`),
    ...Array.from(ipAddresses).map((value, index) => `IP.${index + 1} = ${value}`),
  ].join("\n");

  fs.writeFileSync(
    configFile,
    `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = Wintercircus Quest Dev

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${altNames}
`.trimStart(),
  );

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "30",
      "-keyout",
      KEY_FILE,
      "-out",
      CERT_FILE,
      "-config",
      configFile,
      "-extensions",
      "v3_req",
    ],
    {
      stdio: "ignore",
    },
  );

  return {
    certFile: CERT_FILE,
    keyFile: KEY_FILE,
    lanIpAddress,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = ensureDevCertificate();
  console.log(JSON.stringify(result));
}
