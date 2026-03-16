import path from "node:path";
import { CONFIG } from "./config.mjs";
import { runStaticScan } from "./static-scan.mjs";
import { runDynamicScan } from "./dynamic-scan.mjs";
import {
  BASELINE_FILE,
  LAST_SCAN_FILE,
  HITS_DIR,
  ensureStateDirs,
  nowIso,
  openUrlInBrowser,
  printLine,
  readJsonIfExists,
  sleep,
  stampForFile,
  uniqSorted,
  writeJson
} from "./utils.mjs";

function parseFlags(argv) {
  const flags = {};
  for (const item of argv) {
    if (!item.startsWith("--")) {
      continue;
    }
    const [rawKey, rawValue] = item.slice(2).split("=");
    flags[rawKey] = rawValue === undefined ? true : rawValue;
  }
  return flags;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function selectOpenTargets(scanResult) {
  const candidates = [];
  const push = (value) => {
    if (!value || typeof value !== "string") {
      return;
    }
    if (value.startsWith("http://") || value.startsWith("https://")) {
      candidates.push(value);
    }
  };

  for (const url of scanResult.static.diff.suspiciousCandidates || []) {
    push(url);
  }
  for (const url of scanResult.static.diff.changedImageContentUrls || []) {
    push(url);
  }
  for (const url of scanResult.dynamic.diff.suspiciousCandidates || []) {
    push(url);
  }
  for (const url of scanResult.dynamic.diff.changedDynamicImageContentUrls || []) {
    push(url);
  }
  for (const finding of scanResult.dynamic.dynamic.routeFindings || []) {
    const hasSusText = (finding.overlayTexts || []).some((text) =>
      CONFIG.suspiciousKeywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))
    );
    if (hasSusText) {
      push(finding.url);
    }
  }
  for (const pagePath of scanResult.static.pages.changedPages || []) {
    push(new URL(pagePath, CONFIG.baseUrl).href);
  }

  return uniqSorted(candidates).slice(0, 5);
}

function buildHitSummary(scanResult) {
  const staticDiff = scanResult.static.diff;
  const dynamicDiff = scanResult.dynamic.diff;

  const reasons = [];

  if ((staticDiff.newImageUrls || []).length > 0) {
    reasons.push(`new_static_images=${staticDiff.newImageUrls.length}`);
  }
  if ((staticDiff.changedImageContentUrls || []).length > 0) {
    reasons.push(`changed_static_image_content=${staticDiff.changedImageContentUrls.length}`);
  }
  if ((dynamicDiff.newDynamicUrls || []).length > 0) {
    reasons.push(`new_dynamic_images=${dynamicDiff.newDynamicUrls.length}`);
  }
  if ((dynamicDiff.changedDynamicImageContentUrls || []).length > 0) {
    reasons.push(`changed_dynamic_image_content=${dynamicDiff.changedDynamicImageContentUrls.length}`);
  }
  if ((dynamicDiff.newOverlayTexts || []).length > 0) {
    reasons.push(`new_overlays=${dynamicDiff.newOverlayTexts.length}`);
  }
  if ((staticDiff.suspiciousCandidates || []).length > 0) {
    reasons.push(`suspicious_static=${staticDiff.suspiciousCandidates.length}`);
  }
  if ((dynamicDiff.suspiciousCandidates || []).length > 0) {
    reasons.push(`suspicious_dynamic=${dynamicDiff.suspiciousCandidates.length}`);
  }

  return {
    hasHit: reasons.length > 0,
    reasons
  };
}

async function runFullScan({ baseline, scanId, mode = "quick", captureScreenshots = true }) {
  const staticResult = await runStaticScan({ baseline, mode });
  const dynamicResult = await runDynamicScan({ baseline, scanId, captureScreenshots, mode });

  const merged = {
    timestamp: nowIso(),
    scanId,
    static: staticResult,
    dynamic: dynamicResult
  };

  const hitSummary = buildHitSummary(merged);
  const openTargets = selectOpenTargets(merged);

  return {
    merged,
    hitSummary,
    openTargets
  };
}

function buildBaselineFromScan(scan) {
  return {
    version: 1,
    createdAt: nowIso(),
    source: scan.scanId,
    static: {
      allUrls: scan.static.static.allUrls,
      imageUrls: scan.static.static.imageUrls,
      imageContentHashes: scan.static.static.imageContentHashes || {},
      pageHashes: scan.static.static.pageHashes,
      scriptAssets: scan.static.static.scriptAssets
    },
    dynamic: {
      imageUrls: scan.dynamic.dynamic.imageUrls,
      imageContentHashes: scan.dynamic.dynamic.imageContentHashes || {},
      overlayTexts: scan.dynamic.dynamic.overlayTexts
    }
  };
}

async function cmdInit() {
  await ensureStateDirs();
  const scanId = `init-${stampForFile()}`;
  printLine("init", "building baseline");
  const { merged } = await runFullScan({
    baseline: null,
    scanId,
    mode: "full",
    captureScreenshots: true
  });
  const baseline = buildBaselineFromScan(merged);

  await writeJson(BASELINE_FILE, baseline);
  await writeJson(LAST_SCAN_FILE, merged);

  printLine("baseline saved", BASELINE_FILE);
  printLine("urls", String(baseline.static.allUrls.length));
  printLine("images", String(baseline.static.imageUrls.length));
  printLine("dynamic images", String(baseline.dynamic.imageUrls.length));
}

async function cmdScan(flags) {
  await ensureStateDirs();
  let baseline = await readJsonIfExists(BASELINE_FILE, null);

  if (!baseline || flags["reinit"]) {
    printLine("scan", "no baseline found or --reinit passed, creating baseline first");
    const seedId = `seed-${stampForFile()}`;
    const seeded = await runFullScan({
      baseline: null,
      scanId: seedId,
      mode: "full",
      captureScreenshots: true
    });
    baseline = buildBaselineFromScan(seeded.merged);
    await writeJson(BASELINE_FILE, baseline);
  }

  const scanId = `scan-${stampForFile()}`;
  const scanMode = flags["full"] ? "full" : "quick";
  const { merged, hitSummary, openTargets } = await runFullScan({
    baseline,
    scanId,
    mode: scanMode,
    captureScreenshots: scanMode === "full"
  });
  await writeJson(LAST_SCAN_FILE, merged);

  printLine("scan complete", scanId);
  printLine("summary", hitSummary.reasons.join(", ") || "no changes");

  if (merged.dynamic.warnings?.length) {
    for (const warning of merged.dynamic.warnings) {
      printLine("warning", warning);
    }
  }

  if (hitSummary.hasHit) {
    const hitFile = path.join(HITS_DIR, `${scanId}.json`);
    await writeJson(hitFile, {
      timestamp: nowIso(),
      scanId,
      reasons: hitSummary.reasons,
      openTargets,
      merged
    });
    printLine("HIT", hitFile);

    const shouldOpen = Boolean(flags["open-on-hit"]);
    if (shouldOpen) {
      for (const target of openTargets) {
        printLine("open", target);
        openUrlInBrowser(target);
      }
    }
  }

  if (Boolean(flags["update-baseline"])) {
    const updated = buildBaselineFromScan(merged);
    await writeJson(BASELINE_FILE, updated);
    printLine("baseline updated", BASELINE_FILE);
  }
}

async function cmdWatch(flags) {
  await ensureStateDirs();
  const interval = toNumber(flags.interval, CONFIG.watchIntervalSec);
  const openOnHit = flags["open-on-hit"] !== false;
  const updateBaselineOnLoop = Boolean(flags["update-baseline"]);

  let baseline = await readJsonIfExists(BASELINE_FILE, null);
  if (!baseline || flags["reinit"]) {
    printLine("watch", "creating fresh baseline before loop");
    const seedId = `watch-seed-${stampForFile()}`;
    const seeded = await runFullScan({
      baseline: null,
      scanId: seedId,
      mode: "full",
      captureScreenshots: true
    });
    baseline = buildBaselineFromScan(seeded.merged);
    await writeJson(BASELINE_FILE, baseline);
  }

  printLine("watch started", `interval=${interval}s open_on_hit=${String(openOnHit)}`);

  let loop = 0;
  for (;;) {
    loop += 1;
    const scanId = `watch-${loop}-${stampForFile()}`;
    printLine("loop", `${loop} (${scanId})`);

    const { merged, hitSummary, openTargets } = await runFullScan({
      baseline,
      scanId,
      mode: "quick",
      captureScreenshots: false
    });
    await writeJson(LAST_SCAN_FILE, merged);

    if (merged.dynamic.warnings?.length) {
      for (const warning of merged.dynamic.warnings) {
        printLine("warning", warning);
      }
    }

    if (hitSummary.hasHit) {
      const hitFile = path.join(HITS_DIR, `${scanId}.json`);
      await writeJson(hitFile, {
        timestamp: nowIso(),
        scanId,
        reasons: hitSummary.reasons,
        openTargets,
        merged
      });
      printLine("HIT", hitSummary.reasons.join(", "));
      printLine("hit_file", hitFile);

      if (openOnHit) {
        for (const target of openTargets) {
          printLine("open", target);
          openUrlInBrowser(target);
        }
      }

      // First hit usually wins in live contests; stop unless user requested continuous mode.
      if (!flags["keep-running"]) {
        printLine("watch", "stopping after first hit");
        return;
      }
    } else {
      printLine("no hit", "sleeping");
    }

    if (updateBaselineOnLoop) {
      baseline = buildBaselineFromScan(merged);
      await writeJson(BASELINE_FILE, baseline);
    }

    await sleep(interval * 1000);
  }
}

async function main() {
  const [command = "scan", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === "init") {
    await cmdInit();
    return;
  }
  if (command === "scan") {
    await cmdScan(flags);
    return;
  }
  if (command === "watch") {
    await cmdWatch(flags);
    return;
  }

  console.log("Usage:");
  console.log("  node scripts/treasure-hunt/runner.mjs init");
  console.log(
    "  node scripts/treasure-hunt/runner.mjs scan [--open-on-hit] [--update-baseline] [--reinit] [--full]"
  );
  console.log("  node scripts/treasure-hunt/runner.mjs watch [--interval=12] [--open-on-hit] [--keep-running]");
}

main().catch((error) => {
  console.error("[treasure] fatal", error);
  process.exitCode = 1;
});
