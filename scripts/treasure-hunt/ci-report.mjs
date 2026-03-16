import fs from "node:fs/promises";
import path from "node:path";

const STATE_DIR = path.resolve(".treasure-hunt");
const HITS_DIR = path.join(STATE_DIR, "hits");
const LAST_SCAN_FILE = path.join(STATE_DIR, "last-scan.json");
const SUMMARY_JSON = path.join(STATE_DIR, "ci-summary.json");
const SUMMARY_MD = path.join(STATE_DIR, "ci-summary.md");

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function last(arr) {
  return arr[arr.length - 1];
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

async function getLatestHit(scanId) {
  if (!(await exists(HITS_DIR))) {
    return null;
  }
  const entries = await fs.readdir(HITS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(HITS_DIR, entry.name));

  if (files.length === 0) {
    return null;
  }

  const stats = await Promise.all(
    files.map(async (file) => ({
      file,
      mtimeMs: (await fs.stat(file)).mtimeMs,
      json: await readJson(file, null)
    }))
  );

  const filtered = scanId
    ? stats.filter((entry) => entry.json?.scanId === scanId)
    : stats;
  if (filtered.length === 0) {
    return null;
  }
  filtered.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return last(filtered)?.file || null;
}

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const lastScan = await readJson(LAST_SCAN_FILE, {});
  const lastScanId = lastScan?.scanId || null;
  const latestHitFile = await getLatestHit(lastScanId);
  const latestHit = latestHitFile ? await readJson(latestHitFile, null) : null;

  const hitFound = Boolean(latestHit);
  const reasons = latestHit?.reasons || [];
  const openTargets = latestHit?.openTargets || [];
  const scanId = latestHit?.scanId || lastScan?.scanId || "unknown";
  const timestamp = latestHit?.timestamp || lastScan?.timestamp || new Date().toISOString();

  const summary = {
    hitFound,
    timestamp,
    scanId,
    reasons,
    openTargets,
    latestHitFile,
    staticStats: lastScan?.static?.stats || {},
    dynamicStats: lastScan?.dynamic?.stats || {}
  };

  const md = [
    `# Treasure Monitor Summary`,
    "",
    `- Timestamp: ${timestamp}`,
    `- Scan ID: ${scanId}`,
    `- HIT: ${hitFound ? "YES" : "NO"}`,
    "",
    "## Stats",
    "",
    `- Static pages scanned: ${summary.staticStats.pageCount || 0}`,
    `- Dynamic routes scanned: ${summary.dynamicStats.scannedRoutes || 0}`,
    `- New static image URLs: ${summary.staticStats.newImageUrlCount || 0}`,
    `- New dynamic image URLs: ${summary.dynamicStats.newDynamicUrlCount || 0}`,
    ""
  ];

  if (hitFound) {
    md.push("## HIT Reasons", "");
    for (const reason of reasons) {
      md.push(`- ${escapeMd(reason)}`);
    }
    md.push("", "## Open Targets", "");
    if (openTargets.length === 0) {
      md.push("- (none)");
    } else {
      for (const target of openTargets) {
        md.push(`- ${target}`);
      }
    }
    if (latestHitFile) {
      md.push("", `Hit file: \`${latestHitFile}\``);
    }
  }

  await fs.writeFile(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(SUMMARY_MD, `${md.join("\n")}\n`, "utf8");

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const lines = [
      `hit_found=${hitFound ? "true" : "false"}`,
      `scan_id=${scanId}`,
      `summary_md=${SUMMARY_MD}`,
      `summary_json=${SUMMARY_JSON}`,
      `hit_file=${latestHitFile || ""}`
    ];
    await fs.appendFile(outputFile, `${lines.join("\n")}\n`, "utf8");
  }

  console.log(`[treasure-ci] hit_found=${hitFound}`);
  console.log(`[treasure-ci] scan_id=${scanId}`);
  console.log(`[treasure-ci] summary=${SUMMARY_JSON}`);
}

main().catch((error) => {
  console.error("[treasure-ci] fatal", error);
  process.exitCode = 1;
});
