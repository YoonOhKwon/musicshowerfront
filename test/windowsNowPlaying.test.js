const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNowPlayingReader, parseLine, commandLine, isLocalRequest } = require('../lib/windowsNowPlaying');

test('parseLine accepts typed JSON objects only', () => {
  assert.deepEqual(parseLine('{"type":"state","available":false}\r'), { type: 'state', available: false });
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine('[1,2]'), null);
  assert.equal(parseLine('{"title":"no type"}'), null);
});

test('commandLine only lets whitelisted, well-formed commands through', () => {
  assert.equal(commandLine({ command: 'next' }), '{"command":"next"}');
  assert.equal(commandLine({ command: 'seek', positionMs: 1234.6 }), '{"command":"seek","positionMs":1235}');
  assert.equal(commandLine({ command: 'select', index: -1 }), '{"command":"select","index":-1}');
  assert.equal(commandLine({ command: 'seek', positionMs: -5 }), null);
  assert.equal(commandLine({ command: 'select', index: 1.5 }), null);
  assert.equal(commandLine({ command: 'shutdown' }), null);
  assert.equal(commandLine(), null);
});

test('isLocalRequest requires loopback and a localhost page (or no Origin)', () => {
  const request = (remoteAddress, origin) => ({ socket: { remoteAddress }, get: () => origin });
  assert.equal(isLocalRequest(request('127.0.0.1')), true);
  assert.equal(isLocalRequest(request('::1', 'http://localhost:5173')), true);
  assert.equal(isLocalRequest(request('::ffff:127.0.0.1', 'http://127.0.0.1:3000')), true);
  assert.equal(isLocalRequest(request('192.168.0.8', 'http://localhost:5173')), false);
  assert.equal(isLocalRequest(request('127.0.0.1', 'https://evil.example')), false);
  assert.equal(isLocalRequest(request('127.0.0.1', 'garbage')), false);
});

function fakeSpawn() {
  const children = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.written = [];
    child.stdin.on('data', (chunk) => child.written.push(String(chunk)));
    child.kill = () => child.emit('exit');
    children.push(child);
    return child;
  };
  return { spawnProcess, children };
}

test('reader streams state and artwork, answers commands, and stops when idle', async () => {
  const { spawnProcess, children } = fakeSpawn();
  const reader = createNowPlayingReader({ platform: 'win32', spawnProcess, scriptPath: 'x.ps1', idleStopMs: 10, restartDelayMs: 10_000 });
  assert.equal(children.length, 0, 'nothing runs until someone listens');

  const release = reader.hold();
  assert.equal(children.length, 1);
  assert.equal(children[0].command, 'powershell.exe');
  const child = children[0];

  const states = [];
  reader.onState((state) => states.push(state));
  const key = 'Chrome|Song|Artist';
  child.stdout.write(`{"type":"artwork","key":"${key}","contentType":"image/jpeg","base64":"${Buffer.from('jpg').toString('base64')}"}\n{"type":"sta`);
  child.stdout.write(`te","available":true,"key":"${key}","title":"Song"}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reader.state.title, 'Song', 'lines split across chunks are joined');
  assert.equal(reader.state.running, true);
  assert.ok(reader.state.artworkVersion > 0);
  assert.equal(reader.artwork.contentType, 'image/jpeg');
  assert.equal(reader.artwork.data.toString(), 'jpg');

  child.stdout.write('{"type":"state","available":true,"key":"Chrome|Other|","title":"Other"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reader.state.artworkVersion, 0, 'artwork of the previous track is not reused');

  const pending = reader.command({ command: 'seek', positionMs: 2000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.written.join(''), '{"command":"seek","positionMs":2000}\n');
  child.stdout.write('{"type":"result","command":"seek","ok":true}\n');
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(await reader.command({ command: 'rm -rf' }), { ok: false, error: 'invalid command' });

  release();
  await once(child.stdin, 'finish');
  child.emit('exit');
  assert.equal(reader.state.available, false);
  assert.equal(reader.state.running, false);
  assert.ok(states.length >= 3);
  reader.dispose();
});

test('reader is inert off Windows', async () => {
  const { spawnProcess, children } = fakeSpawn();
  const reader = createNowPlayingReader({ platform: 'darwin', spawnProcess });
  reader.hold()();
  assert.equal(children.length, 0);
  assert.equal(reader.state.supported, false);
  assert.deepEqual(await reader.command({ command: 'next' }), { ok: false, error: 'unsupported platform' });
  reader.dispose();
});
