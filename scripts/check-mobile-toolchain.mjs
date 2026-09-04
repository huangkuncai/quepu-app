import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function command(name, args = ['--version']) {
  try {
    return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

const flutter = command('flutter', ['--version']);
const dart = command('dart', ['--version']);
const xcodebuild = command('xcodebuild', ['-version']);
const pod = command('pod', ['--version']);
const adb = command('adb', ['version']);
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
const sdkManagerPath = androidHome
  ? `${androidHome}/cmdline-tools/latest/bin/sdkmanager`
  : null;
const sdkManager = sdkManagerPath && existsSync(sdkManagerPath);
const androidLicense = androidHome && existsSync(`${androidHome}/licenses/android-sdk-license`);
const androidSdk = androidHome && existsSync(androidHome) && Boolean(adb) && sdkManager && androidLicense;
const devices = flutter ? command('flutter', ['devices']) : null;

const checks = [
  { id: 'flutter', ok: Boolean(flutter), value: flutter },
  { id: 'dart', ok: Boolean(dart), value: dart },
  {
    id: 'android_sdk',
    ok: Boolean(androidSdk),
    value: androidHome
      ? `${androidHome} (sdkmanager=${sdkManager ? 'ok' : 'missing'}, license=${androidLicense ? 'ok' : 'missing'})`
      : 'ANDROID_HOME/ANDROID_SDK_ROOT not set'
  },
  { id: 'xcode', ok: Boolean(xcodebuild), value: xcodebuild },
  { id: 'cocoapods', ok: Boolean(pod), value: pod },
  { id: 'flutter_devices', ok: Boolean(devices), value: devices }
];
const missing = checks.filter(check => !check.ok).map(check => check.id);
console.log(JSON.stringify({
  status: missing.length === 0 ? 'ready' : 'blocked',
  target: 'android-ios',
  checks,
  missing,
  harmony: 'deferred',
  note: 'This is a preflight check only; it does not install SDKs, create signing keys or claim device acceptance.'
}));
process.exitCode = missing.length === 0 ? 0 : 2;
