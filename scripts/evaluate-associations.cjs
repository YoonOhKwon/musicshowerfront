"use strict";
// Evaluate grounded associations across tracks measured by measure-word-diversity.cjs.
//
//   node scripts/evaluate-associations.cjs futurefunk.json horns.json drums.json [--no-judge]
//
// 1. Cross-track overlap: Jaccard similarity of association words between different tracks
//    (lower means the words are more particular to each track).
// 2. Anchor validity: share of proposed words whose cited evidence ids existed and satisfied the
//    listening/genre anchoring rules.
// 3. Blind genericness judge: a separate language-model call rates every word, shuffled and with
//    no track, genre, or category attached, for how well it would fit many unrelated genres.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const OpenAI = require("openai");

const reports = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const judge = !process.argv.includes("--no-judge");
const CATEGORIES = ["culture", "era", "imagery", "aesthetic"];
const ANCHOR_FAILURES = ["invalid-anchor", "no-listening-anchor", "no-genre-anchor"];
const key = text => String(text || "").toLowerCase().replace(/[\s·.,'’"-]+/g, "");

const tracks = reports.map(file => {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const association = report.association || {};
  return { name: path.basename(file, ".json"), association, items: association.items || [] };
});

function jaccard(a, b) {
  const left = new Set(a), right = new Set(b);
  if (!left.size && !right.size) return null;
  const shared = [...left].filter(value => right.has(value)).length;
  return Number((shared / new Set([...left, ...right]).size).toFixed(3));
}

const overlap = [];
for (let i = 0; i < tracks.length; i++) {
  for (let j = i + 1; j < tracks.length; j++) {
    const words = (track, category) => track.items.filter(item => !category || item.category === category)
      .flatMap(item => [key(item.text), key(item.textEn)]);
    overlap.push({ pair: `${tracks[i].name} ~ ${tracks[j].name}`, all: jaccard(words(tracks[i]), words(tracks[j])),
      ...Object.fromEntries(CATEGORIES.map(category => [category, jaccard(words(tracks[i], category), words(tracks[j], category))])) });
  }
}

const anchors = tracks.map(({ name, association }) => {
  const proposed = association.proposed || 0;
  const failed = ANCHOR_FAILURES.reduce((sum, reason) => sum + (association.rejected?.[reason] || 0), 0);
  return { track: name, tier: association.tier, primary: association.primary?.label || null, proposed,
    accepted: association.accepted || 0, anchorFailures: failed,
    anchorValidRate: proposed ? Number(((proposed - failed) / proposed).toFixed(3)) : null,
    rejected: association.rejected || {} };
});

async function blindJudge() {
  const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  if (!judge || !client) return null;
  const words = tracks.flatMap(track => track.items.map(item => ({ track: track.name, category: item.category,
    specificity: item.specificity, ko: item.text, en: item.textEn })));
  const shuffled = words.map((word, index) => ({ ...word, id: `w${index}` }))
    .sort(() => Math.random() - 0.5);
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_LANGUAGE_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-sol",
    messages: [{ role: "user", content: `Rate each word or short phrase for genericness as a description of music.
0 = strongly tied to a particular genre, scene, era, or culture; it would feel wrong for most unrelated music.
1 = generic; it would fit music from almost any genre equally well.
Judge each item on its own. Return exactly one JSON object {"ratings":[{"id":"w0","genericness":0.0}]} with every id.
Items:
${JSON.stringify(shuffled.map(({ id, ko, en }) => ({ id, ko, en })))}` }],
    response_format: { type: "json_object" },
    max_completion_tokens: 4000
  });
  const ratings = new Map((JSON.parse(response.choices[0].message.content).ratings || [])
    .map(rating => [rating.id, Number(rating.genericness)]));
  const scored = shuffled.filter(word => Number.isFinite(ratings.get(word.id)))
    .map(word => ({ ...word, genericness: ratings.get(word.id) }));
  const mean = values => values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null;
  return tracks.map(track => {
    const mine = scored.filter(word => word.track === track.name);
    return { track: track.name, words: mine.length, meanGenericness: mean(mine.map(word => word.genericness)),
      byCategory: Object.fromEntries(CATEGORIES.map(category => [category,
        mean(mine.filter(word => word.category === category).map(word => word.genericness))])),
      bySpecificity: Object.fromEntries(["broad", "family", "specific"].map(level => [level,
        mean(mine.filter(word => word.specificity === level).map(word => word.genericness))])),
      mostGeneric: mine.sort((a, b) => b.genericness - a.genericness).slice(0, 3).map(word => `${word.ko} (${word.genericness})`) };
  }).concat([{ track: "ALL", bySpecificityAndCategory: Object.fromEntries(["broad", "family", "specific"].map(level => [level,
    Object.fromEntries(CATEGORIES.map(category => [category, mean(scored.filter(word => word.specificity === level &&
      word.category === category).map(word => word.genericness))]))])) }]);
}

blindJudge().then(judged => {
  console.log(JSON.stringify({ tracks: tracks.map(track => ({ track: track.name, words: track.items.length,
    byCategory: Object.fromEntries(CATEGORIES.map(category => [category,
      track.items.filter(item => item.category === category).map(item => `${item.text} / ${item.textEn}`)])) })),
    anchors, overlap, blindJudge: judged }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
