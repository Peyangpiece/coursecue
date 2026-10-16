import {writeFile, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo = dirname(dirname(fileURLToPath(import.meta.url))),
  label = 'jp.coursecue.bridge',
  folder = join(homedir(), 'Library/LaunchAgents'),
  logs = join(dirname(repo), 'tmp/coursecue');
await mkdir(folder, {recursive: true});
await mkdir(logs, {recursive: true});
const xml = s => s.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
const file = join(folder, label + '.plist');
await writeFile(
  file,
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(repo, 'local/bridge.js'))}</string></array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict><key>COURSECUE_LAUNCHD</key><string>1</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(logs, 'bridge.out.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs, 'bridge.err.log'))}</string></dict></plist>`
);
const domain = 'gui/' + process.getuid();
try {
  execFileSync('launchctl', ['bootout', domain + '/' + label], {stdio: 'ignore'});
} catch {}
execFileSync('launchctl', ['bootstrap', domain, file]);
console.log('CourseCue Macサービスを登録しました。');
