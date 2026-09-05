// A bounded listening brief, not another detector. Every observation keeps its
// original snapshot path; composing observations never creates new evidence.
const read = (value, path) => path.split('.').reduce((v, k) => v?.[k], value);
const finite = v => typeof v === 'number' && Number.isFinite(v);

function describe(snapshot = {}) {
  const observations = [];
  const missing = [];
  const add = (facet, text, paths, kind = 'observation') =>
    observations.push({ facet, text, kind, anchors: paths });
  const genres = (snapshot.genreEvidence || []).filter(x => x?.label && finite(x.confidence) && x.confidence >= .4)
    .slice(0, 6).sort((a, b) => b.confidence - a.confidence);
  if (snapshot.primaryGenre && snapshot.confidence >= .5) {
    add('genre', `${snapshot.primaryGenre} 계열`, ['primaryGenre', 'confidence'], 'hypothesis');
  } else missing.push('stable genre');
  const alternatives = genres.filter(x => x.label !== snapshot.primaryGenre).slice(0, 3)
    .map(x => ({ label: x.label, confidence: x.confidence, role: 'alternative, not an additional confirmed genre' }));
  const bpm = snapshot.measurements?.bpm;
  const beat = snapshot.measurements?.beatConfidence;
  if (finite(bpm) && bpm > 0 && finite(beat) && beat >= .5)
    add('rhythm', `약 ${Math.round(bpm)} BPM`, ['measurements.bpm', 'measurements.beatConfidence']);
  else missing.push('reliable tempo');
  const grid = snapshot.rhythmicGrammar?.beatGridConfidence;
  if (finite(grid) && grid >= .45) {
    for (const [key, threshold, text] of [['fourOnFloor', .7, '고르게 반복되는 킥'],
      ['syncopation', .7, '엇박 중심의 리듬'], ['swing', .6, '스윙감 있는 리듬']]) {
      if (snapshot.rhythmicGrammar[key] >= threshold)
        add('rhythm', text, [`rhythmicGrammar.${key}`, 'rhythmicGrammar.beatGridConfidence']);
    }
  } else missing.push('reliable beat grid: avoid exact subdivisions and meter claims');
  (snapshot.instrumentation?.observed || []).slice(0, 8).forEach((item, index) => {
    if (item.confidence >= .65 && (item.label || item.id))
      add('instrument', `${String(item.label || item.id).slice(0, 48)} 존재`,
        [`instrumentation.observed.${index}.confidence`, `instrumentation.observed.${index}.${item.label ? 'label' : 'id'}`]);
  });
  if (!observations.some(x => x.facet === 'instrument')) missing.push('reliable instrumentation');
  // These are character descriptions, deliberately not historical or cultural labels.
  for (const [path, low, high] of [
    ['timbre.brightness', '어두운 음색', '밝은 음색'],
    ['timbre.warmth', '차가운 음색', '따뜻한 음색'],
    ['texture.density', '성긴 레이어', '조밀한 레이어'],
    ['texture.sustain', '짧게 끊기는 질감', '길게 이어지는 질감']
  ]) {
    const value = read(snapshot, path);
    if (['low', 'very low', 'high', 'very high'].includes(value))
      add('texture', value.includes('low') ? low : high, [path], 'character');
  }
  for (const [key, text] of [['sidechain', '사이드체인 후보'], ['vocalChop', '보컬 찹 후보'], ['sampleBased', '샘플 기반 구성 후보']]) {
    if (snapshot.productionEvidence?.[key] >= .7)
      add('production', text, [`productionEvidence.${key}`], 'hypothesis');
  }
  const links = [];
  const rhythm = observations.find(x => x.facet === 'rhythm' && !x.text.includes('BPM'));
  const texture = observations.find(x => x.facet === 'texture');
  if (rhythm && texture) links.push({ text: `${texture.text}, ${rhythm.text}`,
    anchors: [...texture.anchors, ...rhythm.anchors], relation: 'coexistence, not causation' });
  const limited = observations.slice(0, 14);
  return { version: 1, basis: 'supplied descriptors; not direct audio listening',
    synopsis: limited.map(x => x.text).join(' · ') || '아직 설명할 음악적 근거가 충분하지 않습니다.',
    observations: limited, alternatives, relationships: links, missing,
    boundaries: ['Genre alternatives are not confirmed influences.',
      'Dark timbre, repetition and warmth do not establish nostalgia, decade, country or culture.',
      'Instrument presence does not establish solo, performer count or recording origin.',
      'No direct audio-language model or verified cultural retrieval is attached to this brief.'] };
}
module.exports = { describe };
