import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatteryStats, parseDuration } from '../src/parse.js';
import { subtractIntervals } from '../src/sleep.js';

const FIXTURE = `Battery History [Format: 2] (1% used):
  11-12 22:00:00.000 080 status=discharging health=good plug=none temp=300 volt=4100 +top=u0a10:"com.example.video"
  11-12 23:00:00.000 070 temp=350 volt=3900
Discharge step durations:
  #0: +4m to 70 (screen-on, power-save-off)
  #1: +20m to 71 (screen-off, power-save-off)
Statistics since last charge:
  Estimated battery capacity: 5000 mAh
  Time on battery: 1h 0m 0s 0ms (100.0%) realtime, 50m 0s 0ms (83.3%) uptime
  Screen on: 30m 0s 0ms (50.0%) 3x, Interactive: 30m 0s 0ms (50.0%)
  Discharge: 500 mAh
  Device battery use since last full charge
    Amount discharged (lower bound): 10
    Amount discharged (upper bound): 11
  Estimated power use (mAh):
    Capacity: 5000, Computed drain: 500, actual drain: 500
    Global
    screen: 100 apps: 0
    cpu: 200 apps: 190 duration: 50m 0s 0ms
      (on battery, screen on)
      cpu: 150 apps: 140 duration: 30m 0s 0ms
  UID u0a10: 120 fg: 100 (30m 0s 0ms) bg: 20.0 (10m 0s 0ms)
      cpu=120 cpu:fg=100 cpu:bg=20.0
  UID 1000: 50.5 bg: 50.5
  Kernel Wake lock GPSD: 1h 2m 3s 4ms (21 times) realtime
  Wake lock u0a10 ExoPlayer: 2m 0s 0ms (5 times) max=100 actual=100 realtime
  Wakeup reason 300 rtc-alarm0: 2m 8s 238ms (85 times) realtime

  u0a10:
    Apk com.example.video:
`;

test('parseDuration sums mixed units', () => {
  assert.equal(parseDuration('1d 2h 3m 4s 5ms'), 93_784_005);
});

test('parseBatteryStats extracts summary fields', () => {
  const r = parseBatteryStats(FIXTURE);
  assert.deepEqual(
    {
      capacity: r.stats.estimatedCapacityMah,
      onBattery: r.stats.timeOnBatteryMs,
      screenOn: r.stats.screenOnMs,
      discharge: r.stats.dischargeMah,
      percent: [r.stats.dischargedPercentLow, r.stats.dischargedPercentHigh],
    },
    { capacity: 5000, onBattery: 3_600_000, screenOn: 1_800_000, discharge: 500, percent: [10, 11] },
  );
});

test('parseBatteryStats reads history range, temperature and voltage', () => {
  const h = parseBatteryStats(FIXTURE).history;
  assert.deepEqual(
    [h.startLevel, h.endLevel, h.minTempC, h.maxTempC, h.minVoltMv, h.maxVoltMv],
    [80, 70, 30, 35, 3900, 4100],
  );
});

test('parseBatteryStats ranks global components only', () => {
  assert.deepEqual(parseBatteryStats(FIXTURE).components, [
    { name: 'cpu', mah: 200 },
    { name: 'screen', mah: 100 },
  ]);
});

test('parseBatteryStats resolves app names and fg/bg split', () => {
  assert.deepEqual(parseBatteryStats(FIXTURE).apps, [
    { uid: 'u0a10', mah: 120, fgMah: 100, bgMah: 20, fgsMah: 0, cachedMah: 0, name: 'com.example.video' },
    { uid: '1000', mah: 50.5, fgMah: 0, bgMah: 50.5, fgsMah: 0, cachedMah: 0, name: 'android system' },
  ]);
});

test('parseBatteryStats averages discharge steps by screen state', () => {
  const s = parseBatteryStats(FIXTURE).dischargeSteps;
  assert.deepEqual(
    [s.avgMsPerPercent, s.avgMsPerPercentScreenOn, s.avgMsPerPercentScreenOff],
    [720_000, 240_000, 1_200_000],
  );
});

test('parseBatteryStats parses wake locks and wakeup reasons', () => {
  const r = parseBatteryStats(FIXTURE);
  assert.deepEqual(
    [r.kernelWakeLocks[0], r.wakeLocks[0], r.wakeupReasons[0]],
    [
      { name: 'GPSD', durationMs: 3_723_004, count: 21 },
      { uid: 'u0a10', name: 'ExoPlayer', durationMs: 120_000, count: 5, app: 'com.example.video' },
      { name: '300 rtc-alarm0', durationMs: 128_238, count: 85 },
    ],
  );
});

test('parseBatteryStats rejects non-batterystats input', () => {
  assert.throws(() => parseBatteryStats('hello'), /Statistics since last charge/);
});

const TIMELINE_FIXTURE = `Battery History [Format: 2] (1% used):
  12-31 23:00:00.000 RESET:TIME: 2025-12-31-23-00-00
  12-31 23:00:00.000 080 status=discharging +running +screen
  12-31 23:30:00.000 080 -screen
  01-01 00:15:00.000 079 -running +plugged
Statistics since last charge:
  Discharge: 10 mAh
`;

test('parseBatteryStats builds level samples and state intervals across a year boundary', () => {
  const h = parseBatteryStats(TIMELINE_FIXTURE).history;
  const t0 = Date.UTC(2025, 11, 31, 23, 0);
  const t1 = Date.UTC(2025, 11, 31, 23, 30);
  const t2 = Date.UTC(2026, 0, 1, 0, 15);
  assert.deepEqual(
    { levels: h.levels, intervals: h.intervals },
    {
      levels: [
        { t: t0, level: 80 },
        { t: t2, level: 79 },
      ],
      intervals: { screen: [[t0, t1]], running: [[t0, t2]], plugged: [[t2, t2]], gps: [] },
    },
  );
});

test('subtractIntervals removes overlapping spans', () => {
  assert.deepEqual(subtractIntervals([0, 100], [[10, 20], [15, 30], [90, 120]]), [
    [0, 10],
    [30, 90],
  ]);
});

const SLEEP_FIXTURE = `Battery History [Format: 2] (1% used):
  01-01 00:00:00.000 RESET:TIME: 2026-01-01-00-00-00
  01-01 00:00:00.000 090 status=discharging +screen +running
  01-01 01:00:00.000 090 -screen -running
  01-01 01:30:00.000 089 +running +gps wake_reason=0:"300 rtc-alarm0" +wake_lock=u0a10:"sync"
  01-01 01:40:00.000 089 -wake_lock device_idle=full
  01-01 02:00:00.000 088 -running -gps
  01-01 02:30:00.000 088 +running wake_reason=0:"300 rtc-alarm0"
  01-01 03:00:00.000 087 +screen device_idle=off
  01-01 03:10:00.000 087 -screen
Statistics since last charge:
  Time on battery screen off: 2h 0m 0s 0ms (66.7%) realtime, 1h 0m 0s 0ms (33.3%) uptime
  Screen off discharge: 100 mAh
  Device light doze discharge: 0 mAh
  Device deep doze discharge: 40 mAh
  Idle mode full time: 1h 20m 0s 0ms (44.4%) 2x -- longest 1h 0m 0s 0ms
  Estimated power use (mAh):
    Global
    cpu: 30 apps: 30
      (on battery, screen off/doze)
      cpu: 12 apps: 12
      wifi: 20 apps: 1
  UID u0a10: 30 bg: 30
      cpu=25 cpu:bg=25 wakelock=5.0 (10m 0s 0ms) wakelock:bg=5.0 (10m 0s 0ms)
      (on battery, screen off/doze) cpu=10 cpu:bg=10 wakelock=5.0 (10m 0s 0ms) wakelock:bg=5.0 (10m 0s 0ms)

  u0a10:
    Apk com.example.sync:
`;

test('analyzeSleep reads screen-off summary stats', () => {
  const s = parseBatteryStats(SLEEP_FIXTURE).sleep;
  assert.deepEqual(
    {
      mahPerHour: s.mahPerHour,
      deepIdle: s.deepIdle,
      components: s.components,
      apps: s.apps.map((a) => [a.name, a.mah]),
    },
    {
      mahPerHour: 50,
      deepIdle: { durationMs: 4_800_000, count: 2, longestMs: 3_600_000 },
      components: [
        { name: 'wifi', mah: 20 },
        { name: 'cpu', mah: 12 },
      ],
      apps: [['com.example.sync', 15]],
    },
  );
});

test('analyzeSleep measures the screen-off session from history', () => {
  const [session] = parseBatteryStats(SLEEP_FIXTURE).sleep.sessions;
  assert.deepEqual(
    {
      durationMs: session.durationMs,
      levels: [session.startLevel, session.endLevel],
      awakeMs: session.awakeMs,
      gpsMs: session.gpsMs,
      deepIdleMs: session.deepIdleMs,
      wakeups: session.wakeups,
      topWakeReasons: session.topWakeReasons,
      topWakeLockHolders: session.topWakeLockHolders,
    },
    {
      durationMs: 7_200_000,
      levels: [90, 87],
      awakeMs: 3_600_000,
      gpsMs: 1_800_000,
      deepIdleMs: 4_800_000,
      wakeups: 2,
      topWakeReasons: [{ name: '300 rtc-alarm0', count: 2 }],
      topWakeLockHolders: [{ name: 'com.example.sync', durationMs: 600_000, count: 1, topTag: 'sync' }],
    },
  );
});
