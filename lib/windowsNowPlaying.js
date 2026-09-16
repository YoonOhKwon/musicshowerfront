"use strict";

// "Now playing" from Windows' system media sessions, without a browser extension: a long-lived
// PowerShell process (scripts/now-playing.ps1) reports the browser tab that is playing (title,
// artist, artwork, position, duration, available controls) and forwards transport commands.
// The process runs only while someone is listening and stops after a quiet period.

const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const COMMANDS = new Set(["toggle", "play", "pause", "next", "previous", "seek", "select"]);
const SCRIPT = path.join(__dirname, "..", "scripts", "now-playing.ps1");

function parseLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  try {
    const message = JSON.parse(text);
    return message && typeof message === "object" && typeof message.type === "string" ? message : null;
  } catch {
    return null;
  }
}

// Returns the JSON line to send, or null for anything the script should not receive.
function commandLine({ command, positionMs, index } = {}) {
  if (!COMMANDS.has(command)) return null;
  const message = { command };
  if (command === "seek") {
    const value = Number(positionMs);
    if (!Number.isFinite(value) || value < 0) return null;
    message.positionMs = Math.round(value);
  }
  if (command === "select") {
    const value = Number(index);
    if (!Number.isInteger(value) || value < -1 || value > 64) return null;
    message.index = value;
  }
  return JSON.stringify(message);
}

function createNowPlayingReader({
  platform = process.platform,
  spawnProcess = spawn,
  scriptPath = SCRIPT,
  idleStopMs = 30_000,
  restartDelayMs = 2_000,
  commandTimeoutMs = 4_000,
} = {}) {
  const events = new EventEmitter();
  const supported = platform === "win32";
  let child = null;
  let buffered = "";
  let listeners = 0;
  let stopTimer = null;
  let restartTimer = null;
  let artwork = null;
  let artworkVersion = 0;
  let state = { available: false, supported, running: false };
  const pending = [];

  function publish(next) {
    // Artwork belongs to one track; a track without a thumbnail must not show the previous one.
    const artworkMatches = artwork && next.available && artwork.key === next.key;
    state = { ...next, supported, running: Boolean(child), artworkVersion: artworkMatches ? artworkVersion : 0 };
    events.emit("state", state);
  }

  function handle(message) {
    if (message.type === "state") {
      publish(message);
    } else if (message.type === "artwork" && message.base64) {
      artwork = { key: message.key, contentType: message.contentType || "image/png", data: Buffer.from(message.base64, "base64") };
      artworkVersion += 1;
      publish(state);
    } else if (message.type === "result") {
      const index = pending.findIndex((item) => item.command === message.command);
      if (index >= 0) {
        const [item] = pending.splice(index, 1);
        clearTimeout(item.timer);
        item.resolve({ ok: Boolean(message.ok) });
      }
    }
  }

  function start() {
    if (!supported || child) return;
    clearTimeout(restartTimer);
    child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const message = parseLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (message) handle(message);
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      publish({ available: false });
      for (const item of pending.splice(0)) {
        clearTimeout(item.timer);
        item.resolve({ ok: false, error: "reader stopped" });
      }
      if (listeners > 0) restartTimer = setTimeout(start, restartDelayMs);
    });
    publish(state);
  }

  function stop() {
    clearTimeout(restartTimer);
    if (!child) return;
    const current = child;
    current.stdin.end();
    setTimeout(() => { if (child === current) current.kill(); }, 1500);
  }

  function hold() {
    listeners += 1;
    clearTimeout(stopTimer);
    start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners = Math.max(0, listeners - 1);
      if (listeners === 0) stopTimer = setTimeout(stop, idleStopMs);
    };
  }

  function command(request) {
    const line = commandLine(request);
    if (!line) return Promise.resolve({ ok: false, error: "invalid command" });
    if (!supported) return Promise.resolve({ ok: false, error: "unsupported platform" });
    start();
    return new Promise((resolve) => {
      const item = { command: request.command, resolve };
      item.timer = setTimeout(() => {
        pending.splice(pending.indexOf(item), 1);
        resolve({ ok: false, error: "timeout" });
      }, commandTimeoutMs);
      pending.push(item);
      child.stdin.write(`${line}\n`);
    });
  }

  return {
    get state() {
      return state;
    },
    get artwork() {
      return artwork;
    },
    onState(listener) {
      events.on("state", listener);
      return () => events.off("state", listener);
    },
    hold,
    command,
    dispose() {
      listeners = 0;
      clearTimeout(stopTimer);
      stop();
    },
  };
}

// Now-playing data is personal and controls playback: answer only this machine, and only pages
// served from localhost (the open CORS policy elsewhere would let any website read it).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLocalRequest(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
  const origin = req.get?.("origin");
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function mountNowPlayingRoutes(app, reader = createNowPlayingReader()) {
  const guard = (req, res, next) => (isLocalRequest(req) ? next() : res.status(403).json({ error: "local only" }));

  app.get("/api/now-playing", guard, (req, res) => {
    const release = reader.hold();
    setTimeout(release, 5_000);
    res.json(reader.state);
  });

  app.get("/api/now-playing/events", guard, (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    const send = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
    const release = reader.hold();
    const off = reader.onState(send);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    send(reader.state);
    req.on("close", () => {
      clearInterval(heartbeat);
      off();
      release();
    });
  });

  app.get("/api/now-playing/artwork", guard, (req, res) => {
    const artwork = reader.artwork;
    if (!artwork || !reader.state.artworkVersion) return res.status(404).end();
    res.set({ "Content-Type": artwork.contentType, "Cache-Control": "private, max-age=3600" });
    res.send(artwork.data);
  });

  app.post("/api/now-playing/command", guard, async (req, res) => {
    const result = await reader.command(req.body || {});
    res.status(result.error === "invalid command" ? 400 : 200).json(result);
  });

  return reader;
}

module.exports = { createNowPlayingReader, mountNowPlayingRoutes, parseLine, commandLine, isLocalRequest };
