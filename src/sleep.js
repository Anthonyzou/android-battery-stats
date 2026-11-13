const HOUR_MS = 3_600_000;
const MIN_SESSION_MS = 10 * 60_000;

function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function subtractIntervals([start, end], remove) {
  const out = [];
  let cursor = start;
  for (const [a, b] of mergeIntervals(remove)) {
    if (b <= cursor) continue;
    if (a >= end) break;
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) out.push([cursor, end]);
  return out;
}

function overlapMs(intervals, a, b) {
  let total = 0;
  for (const [x, y] of intervals) total += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return total;
}

function levelAt(levels, t) {
  let level = levels[0].level;
  for (const s of levels) {
    if (s.t > t) break;
    level = s.level;
  }
  return level;
}

function topCounts(entries, keyOf, limit) {
  const counts = new Map();
  for (const e of entries) counts.set(keyOf(e), (counts.get(keyOf(e)) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function measure(history, periods, label) {
  const { intervals, deviceIdle, levels } = history;
  let durationMs = 0;
  let awakeMs = 0;
  let gpsMs = 0;
  let deepIdleMs = 0;
  let lightIdleMs = 0;
  let levelDrop = 0;
  let wakeups = 0;
  const reasons = [];
  const holders = new Map();
  for (const [a, b] of periods) {
    durationMs += b - a;
    awakeMs += overlapMs(intervals.running, a, b);
    gpsMs += overlapMs(intervals.gps, a, b);
    deepIdleMs += overlapMs(deviceIdle.full, a, b);
    lightIdleMs += overlapMs(deviceIdle.light, a, b);
    levelDrop += Math.max(0, levelAt(levels, a) - levelAt(levels, b));
    wakeups += intervals.running.filter(([x]) => x > a && x < b).length;
    reasons.push(...history.wakeReasons.filter((r) => r.t >= a && r.t < b));
    for (const [x, y, uid, tag] of history.wakeLocks) {
      const ms = Math.max(0, Math.min(b, y) - Math.max(a, x));
      if (ms === 0 || uid === null) continue;
      const name = label(uid);
      const entry = holders.get(name) ?? { name, durationMs: 0, count: 0, tags: new Map() };
      entry.durationMs += ms;
      entry.count += 1;
      entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + ms);
      holders.set(name, entry);
    }
  }
  const hours = durationMs / HOUR_MS;
  return {
    durationMs,
    awakeMs,
    gpsMs,
    deepIdleMs,
    lightIdleMs,
    levelDrop,
    percentPerHour: hours > 0 ? levelDrop / hours : null,
    wakeups,
    wakeupsPerHour: hours > 0 ? wakeups / hours : null,
    topWakeReasons: topCounts(reasons, (r) => r.reason, 10),
    topWakeLockHolders: [...holders.values()]
      .sort((x, y) => y.durationMs - x.durationMs)
      .map(({ tags, ...h }) => ({
        ...h,
        topTag: [...tags].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '',
      })),
  };
}

export function analyzeSleep({ history, stats, screenOffPower, label }) {
  const result = {
    screenOffMs: stats.screenOffOnBatteryMs,
    screenOffDischargeMah: stats.screenOffDischargeMah,
    lightDozeDischargeMah: stats.lightDozeDischargeMah,
    deepDozeDischargeMah: stats.deepDozeDischargeMah,
    deepIdle: stats.deepIdle,
    lightIdle: stats.lightIdle,
    mahPerHour:
      stats.screenOffDischargeMah !== null && stats.screenOffOnBatteryMs
        ? stats.screenOffDischargeMah / (stats.screenOffOnBatteryMs / HOUR_MS)
        : null,
    components: screenOffPower.components,
    apps: screenOffPower.apps.map((a) => ({ ...a, name: label(a.uid) })),
    totals: null,
    sessions: [],
  };
  if (!history || history.levels.length < 2) return result;

  const window = [history.levels[0].t, history.levels.at(-1).t];
  const periods = subtractIntervals(window, [...history.intervals.screen, ...history.intervals.plugged]);
  result.totals = measure(history, periods, label);
  result.sessions = periods
    .filter(([a, b]) => b - a >= MIN_SESSION_MS)
    .map(([a, b]) => ({
      start: a,
      end: b,
      startLevel: levelAt(history.levels, a),
      endLevel: levelAt(history.levels, b),
      ...measure(history, [[a, b]], label),
    }));
  return result;
}
