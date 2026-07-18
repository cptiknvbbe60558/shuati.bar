#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "https://shuati.bar";
const targetUrl = process.env.TARGET_URL || DEFAULT_URL;
const confirmRestore = process.env.CONFIRM_RESTORE === "1";
const restoreEmpty = process.env.RESTORE_EMPTY === "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countActiveMap(map = {}) {
  return Object.values(map || {}).filter((value) => value !== false).length;
}

function summarizeState(value = {}) {
  return {
    wrong: Object.values(value.wrong || {}).filter((record) => record?.active !== false).length,
    favorites: countActiveMap(value.favorites || {}),
    notes: Object.keys(value.notes || {}).length,
    mastery: Object.keys(value.mastery || {}).length,
    suitePapers: Array.isArray(value.suitePapers) ? value.suitePapers.length : 0,
    suiteExposure: Object.keys(value.suiteExposure || {}).length,
	wrongEliminationPapers: Array.isArray(value.wrongEliminationPapers) ? value.wrongEliminationPapers.length : 0,
	wrongEliminationExposure: Object.keys(value.wrongEliminationExposure || {}).length,
    updatedAt: value.updatedAt || value._protectedUpdatedAt || null
  };
}

function hasUsefulState(summary) {
  return Boolean(
    summary.wrong ||
    summary.favorites ||
    summary.notes ||
    summary.mastery ||
    summary.suitePapers ||
	summary.suiteExposure ||
	summary.wrongEliminationPapers ||
	summary.wrongEliminationExposure
  );
}

function hasUsefulSession(session = {}) {
  return Boolean(
    session?.wrongPracticeSession?.updatedAt
	|| session?.suiteSession?.updatedAt
	|| session?.wrongEliminationSession?.updatedAt
  );
}

async function postState(staffId, value) {
  const response = await fetch(`${targetUrl}/api/state/${encodeURIComponent(staffId)}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value || {})
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(`restore failed for ${staffId}: ${response.status} ${payload?.error || ""}`);
  }
}

async function postSession(staffId, value) {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return;
  const response = await fetch(`${targetUrl}/api/session/${encodeURIComponent(staffId)}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(`session restore failed for ${staffId}: ${response.status} ${payload?.error || ""}`);
  }
}

function readBackup(filePath) {
  const backup = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(backup?.app === "shuati-bar", "backup file is not a shuati-bar backup");
  assert(backup?.states && typeof backup.states === "object", "backup file has no states object");
  return backup;
}

async function run() {
  const backupPath = process.argv[2];
  assert(backupPath, "usage: node scripts/restore-state.js state-backups/shuati-state-....json");
  const backup = readBackup(path.resolve(backupPath));
  const planned = [];
  const skipped = [];

  for (const [staffId, record] of Object.entries(backup.states)) {
    const value = record?.value || {};
    const summary = summarizeState(value);
    if (!restoreEmpty && !hasUsefulState(summary) && !hasUsefulSession(record?.session)) {
      skipped.push({ staffId, reason: "empty_state" });
      continue;
    }
    planned.push({ staffId, summary });
    if (confirmRestore) {
      await postState(staffId, value);
      await postSession(staffId, record?.session || {});
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: !confirmRestore,
    targetUrl,
    backupPath: path.resolve(backupPath),
    backupExportedAt: backup.exportedAt,
    plannedCount: planned.length,
    skipped,
    restoredCount: confirmRestore ? planned.length : 0,
    planned
  }, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
