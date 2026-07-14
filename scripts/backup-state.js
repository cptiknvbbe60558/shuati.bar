#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_FROM = 704001;
const DEFAULT_TO = 704099;
const DEFAULT_OUTPUT_DIR = "state-backups";

const targetUrl = process.env.TARGET_URL || DEFAULT_URL;
const from = Number(process.env.STAFF_FROM || DEFAULT_FROM);
const to = Number(process.env.STAFF_TO || DEFAULT_TO);
const includeEmpty = process.env.INCLUDE_EMPTY === "1";
const outputDir = process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function staffIds() {
  const ids = [];
  for (let number = from; number <= to; number += 1) {
    ids.push(String(number).padStart(6, "0"));
  }
  return ids;
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
    summary.suiteExposure
  );
}

function hasUsefulSession(session = {}) {
  return Boolean(
    session?.wrongPracticeSession?.updatedAt
    || session?.suiteSession?.updatedAt
  );
}

async function fetchState(staffId) {
  const requestOptions = {
    cache: "no-store",
    headers: { Accept: "application/json" }
  };
  const [stateResponse, sessionResponse] = await Promise.all([
    fetch(`${targetUrl}/api/state/${encodeURIComponent(staffId)}`, requestOptions),
    fetch(`${targetUrl}/api/session/${encodeURIComponent(staffId)}`, requestOptions)
  ]);
  const [statePayload, sessionPayload] = await Promise.all([
    stateResponse.json().catch(() => null),
    sessionResponse.json().catch(() => null)
  ]);
  if (!stateResponse.ok || !statePayload?.success) {
    return {
      staffId,
      ok: false,
      status: stateResponse.status,
      error: statePayload?.error || "state_read_failed",
      value: {},
      session: {}
    };
  }
  return {
    staffId,
    ok: true,
    status: stateResponse.status,
    value: statePayload.value || {},
    session: sessionResponse.ok && sessionPayload?.success
      ? (sessionPayload.value || {})
      : {}
  };
}

async function run() {
  assert(Number.isInteger(from) && Number.isInteger(to) && from <= to, "invalid STAFF_FROM/STAFF_TO range");
  const states = {};
  const errors = [];
  const totals = {
    wrong: 0,
    favorites: 0,
    notes: 0,
    mastery: 0,
    suitePapers: 0,
    suiteExposure: 0
  };

  for (const staffId of staffIds()) {
    const result = await fetchState(staffId);
    const summary = summarizeState(result.value);
    if (!result.ok) {
      errors.push({ staffId, status: result.status, error: result.error });
      continue;
    }
    if (!includeEmpty && !hasUsefulState(summary) && !hasUsefulSession(result.session)) continue;
    states[staffId] = {
      value: result.value,
      session: result.session,
      summary
    };
    for (const key of Object.keys(totals)) {
      totals[key] += Number(summary[key]) || 0;
    }
  }

  const exportedAt = new Date().toISOString();
  const safeStamp = exportedAt.replace(/[:.]/g, "-");
  const outputPath = path.resolve(outputDir, `shuati-state-${safeStamp}.json`);
  const backup = {
    version: 2,
    app: "shuati-bar",
    targetUrl,
    exportedAt,
    staffRange: { from, to },
    includeEmpty,
    states,
    summary: {
      staffCount: Object.keys(states).length,
      errors,
      totals
    }
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(backup, null, 2));

  console.log(JSON.stringify({
    ok: errors.length === 0,
    outputPath,
    targetUrl,
    exportedAt,
    staffCount: backup.summary.staffCount,
    totals,
    errors
  }, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
