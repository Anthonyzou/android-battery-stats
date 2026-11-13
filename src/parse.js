import { analyzeSleep } from './sleep.js';

const DURATION = String.raw`((?:\d+(?:ms|d|h|m|s)\s?)+)`;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

const KNOWN_UIDS = {
  0: 'root (kernel)',
  1000: 'android system',
  1001: 'radio (phone)',
  1002: 'bluetooth',
  1010: 'wifi',
  1013: 'media',
  1021: 'gps',
  1041: 'audioserver',
  1047: 'cameraserver',
};

export function parseDuration(text) {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)(ms|d|h|m|s)/g)) {
    total += Number(n) * UNIT_MS[unit];
  }
  return total;
}

function sectionLines(lines, header) {
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] !== '' && !lines[i].startsWith(' ')) break;
    out.push(lines[i]);
  }
  return out;
}

const TIMELINE_STATES = ['screen', 'running', 'plugged', 'gps'];

function historyTimeMs(time, year) {
  const [, mo, d, h, mi, s, ms] = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(time).map(Number);
  return Date.UTC(year, mo - 1, d, h, mi, s, ms);
}

function parseHistory(lines) {
  const re = /^  (\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) (\d{3})(?: (.*))?$/;
  const clockRe = /^  \d\d-\d\d \d\d:\d\d:\d\d\.\d{3} (?:RESET:)?TIME: (\d{4})-/;
  const stateRe = new RegExp(String.raw`(?:^| )([+-])(${TIMELINE_STATES.join('|')})(?= |$)`, 'g');
  const wakeLockRe = /(?:^| )([+-])wake_lock(?:=(-?[\w]+):"([^"]*)")?(?= |$)/g;
  const wakeReasonRe = /(?:^| )wake_reason=\S+?:"([^"]*)"/g;
  const deviceIdleRe = /(?:^| )device_idle=(full|light|off)(?= |$)/;
  const history = {
    start: null,
    end: null,
    startLevel: null,
    endLevel: null,
    minLevel: null,
    maxLevel: null,
    minTempC: null,
    maxTempC: null,
    minVoltMv: null,
    maxVoltMv: null,
    statusChanges: [],
    levels: [],
    intervals: Object.fromEntries(TIMELINE_STATES.map((k) => [k, []])),
    deviceIdle: { full: [], light: [] },
    wakeReasons: [],
    wakeLocks: [],
  };
  let lastStatus = null;
  let year = new Date().getUTCFullYear();
  let lastMonth = null;
  let lastMs = null;
  const openSince = {};
  let idleMode = 'off';
  let idleSince = null;
  let openWakeLock = null;
  for (const line of lines) {
    const clock = clockRe.exec(line);
    if (clock) {
      year = Number(clock[1]);
      continue;
    }
    const m = re.exec(line);
    if (!m) continue;
    const [, time, levelText, rest = ''] = m;
    const level = Number(levelText);
    const month = Number(time.slice(0, 2));
    if (lastMonth !== null && month < lastMonth) year++;
    lastMonth = month;
    const ms = historyTimeMs(time, year);
    lastMs = ms;
    if (history.levels.length === 0 || history.levels.at(-1).level !== level) {
      history.levels.push({ t: ms, level });
    }
    for (const [, sign, key] of rest.matchAll(stateRe)) {
      if (sign === '+') openSince[key] ??= ms;
      else if (openSince[key] !== undefined) {
        history.intervals[key].push([openSince[key], ms]);
        delete openSince[key];
      }
    }
    const idle = deviceIdleRe.exec(rest);
    if (idle && idle[1] !== idleMode) {
      if (idleMode !== 'off') history.deviceIdle[idleMode].push([idleSince, ms]);
      idleMode = idle[1];
      idleSince = ms;
    }
    for (const [, reason] of rest.matchAll(wakeReasonRe)) {
      history.wakeReasons.push({ t: ms, reason });
    }
    // History records only the first holder of the partial wake lock, so a new
    // "+" implicitly ends the previous span.
    for (const [, sign, uid, tag] of rest.matchAll(wakeLockRe)) {
      if (openWakeLock) {
        history.wakeLocks.push([openWakeLock.start, ms, openWakeLock.uid, openWakeLock.tag]);
        openWakeLock = null;
      }
      if (sign === '+') openWakeLock = { start: ms, uid: uid ?? null, tag: tag ?? '' };
    }
    history.start ??= time;
    history.startLevel ??= level;
    history.end = time;
    history.endLevel = level;
    history.minLevel = Math.min(history.minLevel ?? level, level);
    history.maxLevel = Math.max(history.maxLevel ?? level, level);

    const temp = /(?:^| )temp=(\d+)/.exec(rest);
    if (temp) {
      const c = Number(temp[1]) / 10;
      history.minTempC = Math.min(history.minTempC ?? c, c);
      history.maxTempC = Math.max(history.maxTempC ?? c, c);
    }
    const volt = /(?:^| )volt=(\d+)/.exec(rest);
    if (volt) {
      const v = Number(volt[1]);
      history.minVoltMv = Math.min(history.minVoltMv ?? v, v);
      history.maxVoltMv = Math.max(history.maxVoltMv ?? v, v);
    }
    const status = /(?:^| )status=([a-z-]+)/.exec(rest);
    if (status && status[1] !== lastStatus) {
      lastStatus = status[1];
      history.statusChanges.push({ time, level, status: status[1] });
    }
  }
  if (lastMs !== null) {
    if (history.levels.at(-1).t !== lastMs) history.levels.push({ t: lastMs, level: history.endLevel });
    for (const [key, since] of Object.entries(openSince)) history.intervals[key].push([since, lastMs]);
    if (idleMode !== 'off') history.deviceIdle[idleMode].push([idleSince, lastMs]);
    if (openWakeLock) history.wakeLocks.push([openWakeLock.start, lastMs, openWakeLock.uid, openWakeLock.tag]);
  }
  return history.start === null ? null : history;
}

function parseUidNames(lines) {
  const names = new Map();
  let currentUid = null;
  for (const line of lines) {
    const uid = /^  (u\d+a\d+|\d+):$/.exec(line);
    if (uid) {
      currentUid = uid[1];
      continue;
    }
    const apk = /^    Apk (.+):$/.exec(line);
    if (apk && currentUid && !names.has(currentUid)) {
      names.set(currentUid, apk[1]);
      continue;
    }
    for (const [, id, pkg] of line.matchAll(/(?:^| )[+-]?(?:top|fg)=(u\d+a\d+|\d+):"([^"]+)"/g)) {
      if (!names.has(id)) names.set(id, pkg);
    }
  }
  return names;
}

export function uidLabel(uid, names) {
  if (uid in KNOWN_UIDS) return KNOWN_UIDS[uid];
  return names.get(uid) ?? uid;
}

function parseStats(statsLines) {
  const fields = new Map();
  for (const line of statsLines) {
    const m = /^  ([A-Z][^:]*): (.*)$/.exec(line);
    if (m && !fields.has(m[1])) fields.set(m[1], m[2].trim());
  }
  const mah = (key) => {
    const v = fields.get(key);
    return v === undefined ? null : Number.parseFloat(v);
  };
  const dur = (key) => {
    const v = fields.get(key);
    return v === undefined ? null : parseDuration(v.split(/[(,]/)[0]);
  };
  const amount = (label) => {
    const re = new RegExp(String.raw`^    Amount discharged ${label}: (\d+)`);
    for (const line of statsLines) {
      const m = re.exec(line);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const idleMode = (key) => {
    const v = fields.get(key);
    const m = v === undefined ? null : new RegExp(String.raw`^${DURATION}.*?(\d+)x(?: -- longest ${DURATION})?`).exec(v);
    return m
      ? { durationMs: parseDuration(m[1]), count: Number(m[2]), longestMs: m[3] ? parseDuration(m[3]) : null }
      : null;
  };
  return {
    estimatedCapacityMah: mah('Estimated battery capacity'),
    learnedCapacityMah: mah('Last learned battery capacity'),
    startClockTime: fields.get('Start clock time') ?? null,
    timeOnBatteryMs: dur('Time on battery'),
    screenOffOnBatteryMs: dur('Time on battery screen off'),
    screenOnMs: dur('Screen on'),
    chargeTimeRemainingMs: dur('Charge time remaining'),
    batteryTimeRemainingMs: dur('Battery time remaining'),
    dischargeMah: mah('Discharge'),
    screenOnDischargeMah: mah('Screen on discharge'),
    screenOffDischargeMah: mah('Screen off discharge'),
    lightDozeDischargeMah: mah('Device light doze discharge'),
    deepDozeDischargeMah: mah('Device deep doze discharge'),
    deepIdle: idleMode('Idle mode full time'),
    lightIdle: idleMode('Idle mode light time'),
    fullWakelockMs: dur('Total full wakelock time'),
    partialWakelockMs: dur('Total partial wakelock time'),
    dischargedPercentLow: amount(String.raw`\(lower bound\)`),
    dischargedPercentHigh: amount(String.raw`\(upper bound\)`),
    dischargedPercentScreenOn: amount('while screen on'),
    dischargedPercentScreenOff: amount('while screen off'),
  };
}

function parsePowerUse(statsLines) {
  const start = statsLines.findIndex((l) => l === '  Estimated power use (mAh):');
  const components = [];
  const apps = [];
  if (start === -1) return { components, apps };

  let inGlobal = false;
  for (let i = start + 1; i < statsLines.length; i++) {
    const line = statsLines[i];
    if (line === '    Global') {
      inGlobal = true;
      continue;
    }
    const comp = /^    (\w+): ([\d.]+) apps: [\d.]+/.exec(line);
    if (inGlobal && comp) {
      components.push({ name: comp[1], mah: Number(comp[2]) });
      continue;
    }
    if (/^      \(/.test(line)) {
      inGlobal = false;
      continue;
    }
    const uid = /^  UID (\S+): ([\d.]+)(.*)$/.exec(line);
    if (uid) {
      const part = (key) => {
        const m = new RegExp(String.raw`(?:^| )${key}: ([\d.]+)`).exec(uid[3]);
        return m ? Number(m[1]) : 0;
      };
      apps.push({
        uid: uid[1],
        mah: Number(uid[2]),
        fgMah: part('fg'),
        bgMah: part('bg'),
        fgsMah: part('fgs'),
        cachedMah: part('cached'),
      });
      continue;
    }
    if (/^  [^ U]/.test(line)) break;
  }
  components.sort((a, b) => b.mah - a.mah);
  apps.sort((a, b) => b.mah - a.mah);
  return { components, apps };
}

function parseScreenOffPower(statsLines) {
  const start = statsLines.findIndex((l) => l === '  Estimated power use (mAh):');
  const components = [];
  const apps = [];
  if (start === -1) return { components, apps };

  let scope = null;
  let currentUid = null;
  for (let i = start + 1; i < statsLines.length; i++) {
    const line = statsLines[i];
    if (line === '    Global') {
      scope = 'global';
      continue;
    }
    const sub = /^      \((.*?)\)(.*)$/.exec(line);
    if (sub && scope !== 'app') {
      scope = sub[1] === 'on battery, screen off/doze' ? 'global-off' : 'global';
      continue;
    }
    const comp = /^      (\w+): ([\d.]+) apps: [\d.]+/.exec(line);
    if (scope === 'global-off' && comp) {
      components.push({ name: comp[1], mah: Number(comp[2]) });
      continue;
    }
    const uid = /^  UID (\S+): /.exec(line);
    if (uid) {
      scope = 'app';
      currentUid = uid[1];
      continue;
    }
    if (scope === 'app' && sub && sub[1] === 'on battery, screen off/doze') {
      const breakdown = {};
      for (const [, key, value] of sub[2].matchAll(/(?:^| )(\w+)=([\d.]+)/g)) breakdown[key] = Number(value);
      const mah = Object.values(breakdown).reduce((s, v) => s + v, 0);
      if (mah > 0) apps.push({ uid: currentUid, mah, breakdown });
      continue;
    }
    if (/^  [^ U]/.test(line)) break;
  }
  components.sort((a, b) => b.mah - a.mah);
  apps.sort((a, b) => b.mah - a.mah);
  return { components, apps };
}

function parseTimedEntries(statsLines, prefix, hasOwner) {
  const owner = hasOwner ? String.raw`(\S+) ` : '()';
  const re = new RegExp(String.raw`^  ${prefix} ${owner}(.*): ${DURATION}\((\d+) times\)`);
  const out = [];
  for (const line of statsLines) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      ...(hasOwner ? { uid: m[1] } : {}),
      name: m[2],
      durationMs: parseDuration(m[3]),
      count: Number(m[4]),
    });
  }
  return out.sort((a, b) => b.durationMs - a.durationMs);
}

function parseRadioDrain(statsLines) {
  const find = (re) => {
    for (const line of statsLines) {
      const m = re.exec(line);
      if (m) return Number(m[1]);
    }
    return null;
  };
  return {
    cellularMah: find(/^\s+Cellular Battery drain: ([\d.]+)mAh/),
    wifiMah: find(/^\s+WiFi Battery drain: ([\d.]+)mAh/),
    gpsMah: find(/^\s+GPS Battery Drain: ([\d.]+)mAh/),
  };
}

function parseDischargeSteps(lines) {
  const steps = [];
  for (const line of sectionLines(lines, 'Discharge step durations:')) {
    const m = /^  #\d+: \+(\S+) to (\d+) \((.*)\)/.exec(line);
    if (!m) continue;
    const modes = m[3].split(', ');
    steps.push({
      durationMs: parseDuration(m[1]),
      level: Number(m[2]),
      screen: modes.includes('screen-on') ? 'on' : modes.includes('screen-off') ? 'off' : 'mixed',
    });
  }
  const avg = (list) =>
    list.length === 0 ? null : list.reduce((s, x) => s + x.durationMs, 0) / list.length;
  return {
    count: steps.length,
    avgMsPerPercent: avg(steps),
    avgMsPerPercentScreenOn: avg(steps.filter((s) => s.screen === 'on')),
    avgMsPerPercentScreenOff: avg(steps.filter((s) => s.screen === 'off')),
  };
}

export function parseBatteryStats(text) {
  const lines = text.split(/\r?\n/);
  const statsLines = sectionLines(lines, 'Statistics since last charge:');
  if (statsLines.length === 0) {
    throw new Error('No "Statistics since last charge:" section found; is this a dumpsys batterystats file?');
  }
  const names = parseUidNames(lines);
  const label = (uid) => uidLabel(uid, names);
  const { components, apps } = parsePowerUse(statsLines);
  const stats = parseStats(statsLines);
  const history = parseHistory(lines);
  return {
    stats,
    history,
    dischargeSteps: parseDischargeSteps(lines),
    radio: parseRadioDrain(statsLines),
    components,
    apps: apps.map((a) => ({ ...a, name: label(a.uid) })),
    wakeLocks: parseTimedEntries(statsLines, 'Wake lock', true).map((w) => ({
      ...w,
      app: label(w.uid),
    })),
    kernelWakeLocks: parseTimedEntries(statsLines, 'Kernel Wake lock', false),
    wakeupReasons: parseTimedEntries(statsLines, 'Wakeup reason', false),
    sleep: analyzeSleep({ history, stats, screenOffPower: parseScreenOffPower(statsLines), label }),
  };
}
