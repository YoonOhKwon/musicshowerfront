const test = require("node:test");
const assert = require("node:assert/strict");
const { LAYER_TEXT_STYLE, layerTextStyle } = require("../js/visual/floatingWord");

test("every layer has a declared text style, and strict layers stay full-weight/full-opacity", () => {
  for (const layer of ["LIVE", "FACT", "CONTEXT", "AESTHETIC", "IMPRESSION"]) assert.ok(LAYER_TEXT_STYLE[layer], layer);
  assert.deepEqual(LAYER_TEXT_STYLE.LIVE, { bold: true, alphaScale: 1 });
  assert.deepEqual(LAYER_TEXT_STYLE.FACT, { bold: true, alphaScale: 1 });
});

test("the open layer (AESTHETIC/IMPRESSION) reads as visually softer than FACT: lighter weight, reduced opacity", () => {
  for (const layer of ["AESTHETIC", "IMPRESSION"]) {
    assert.equal(LAYER_TEXT_STYLE[layer].bold, false, layer);
    assert.ok(LAYER_TEXT_STYLE[layer].alphaScale < LAYER_TEXT_STYLE.FACT.alphaScale, layer);
  }
});

test("CONTEXT sits between strict and open: still bold (a style hypothesis is still fairly literal), but slightly softer than FACT", () => {
  assert.equal(LAYER_TEXT_STYLE.CONTEXT.bold, true);
  assert.ok(LAYER_TEXT_STYLE.CONTEXT.alphaScale < LAYER_TEXT_STYLE.FACT.alphaScale);
  assert.ok(LAYER_TEXT_STYLE.CONTEXT.alphaScale > LAYER_TEXT_STYLE.AESTHETIC.alphaScale);
});

test("layerTextStyle falls back to FACT's style for an unrecognized/missing layer, never crashes", () => {
  assert.deepEqual(layerTextStyle({ layer: "NOT_A_REAL_LAYER" }), LAYER_TEXT_STYLE.FACT);
  assert.deepEqual(layerTextStyle({}), LAYER_TEXT_STYLE.FACT);
});

test("layerTextStyle resolves each declared layer to its own style", () => {
  for (const layer of Object.keys(LAYER_TEXT_STYLE)) assert.deepEqual(layerTextStyle({ layer }), LAYER_TEXT_STYLE[layer]);
});
