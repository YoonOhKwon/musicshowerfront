"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { app, attachRealtimeAudioSocket } = require("../server");

test("PCM sent over WebSocket returns features and a realtime word pool", async (t) => {
  const server = http.createServer(app);
  const socketServer = attachRealtimeAudioSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/music-shower`);
  t.after(async () => {
    client.close();
    socketServer.close();
    await new Promise(resolve => server.close(resolve));
  });

  const received = [];
  client.on("message", data => received.push(JSON.parse(data.toString("utf8"))));
  await once(client, "open");
  client.send(JSON.stringify({ type: "start", sampleRate: 16000, format: "f32le" }));

  const samples = new Float32Array(16000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * 110 * Math.PI * 2 / 16000) * 0.35;
  }
  client.send(Buffer.from(samples.buffer));

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !received.some(message => message.type === "word_pool" && message.tokens.length)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const features = received.find(message => message.type === "features");
  const pool = received.find(message => message.type === "word_pool" && message.tokens.length);
  assert.equal(features?.live, true);
  assert.ok(pool?.tokens?.length >= 2);
  assert.equal(pool.streamId, features.streamId);
  assert.equal(pool.poolSource, "music-shower-final");
});

test("one visitor's word pool is not broadcast to another visitor", async (t) => {
  const server = http.createServer(app);
  const socketServer = attachRealtimeAudioSocket(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const first = new WebSocket(`ws://127.0.0.1:${port}/ws/music-shower`);
  const second = new WebSocket(`ws://127.0.0.1:${port}/ws/music-shower`);
  t.after(async () => {
    first.close();
    second.close();
    socketServer.close();
    await new Promise(resolve => server.close(resolve));
  });
  const firstMessages = [];
  const secondMessages = [];
  first.on("message", data => firstMessages.push(JSON.parse(data.toString("utf8"))));
  second.on("message", data => secondMessages.push(JSON.parse(data.toString("utf8"))));
  await Promise.all([once(first, "open"), once(second, "open")]);

  first.send(JSON.stringify({ type: "start", sampleRate: 16000, format: "f32le" }));
  const samples = new Float32Array(16000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * 110 * Math.PI * 2 / 16000) * 0.35;
  }
  first.send(Buffer.from(samples.buffer));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !firstMessages.some(message => message.type === "word_pool")) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(firstMessages.some(message => message.type === "word_pool"));
  assert.equal(secondMessages.some(message => message.type === "word_pool"), false);
});
