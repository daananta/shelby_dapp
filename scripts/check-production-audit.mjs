import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout || "{}");
} catch {
  console.error("Could not parse the production dependency audit.");
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities;
if (!counts) {
  console.error("The production dependency audit did not return vulnerability counts.");
  process.exit(1);
}

console.log(`Production dependency audit: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate.`);
if (counts.critical > 0 || counts.high > 0) process.exit(1);
