const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const inputDir = process.env.MAKEFUN_BOT_DIR || ".";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const bytes = readFileSync(join(inputDir, "LAUNCH.json"));

let launch;
try {
  launch = JSON.parse(bytes.toString("utf8"));
} catch {
  throw new Error("LAUNCH.json must contain valid JSON");
}
if (launch === null || typeof launch !== "object" || Array.isArray(launch)) {
  throw new Error("LAUNCH.json must contain a JSON object");
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "LAUNCH.json"), bytes);
