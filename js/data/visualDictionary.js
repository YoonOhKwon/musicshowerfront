const VISUAL_DICTIONARY = [
  { keywords: ["네온", "형광", "빛", "잔광"], hue: 318, saturation: 0.82, brightness: 1.25, glow: 2, speed: 1.15 },
  { keywords: ["유리", "얼음", "투명", "결정"], hue: 198, saturation: 0.5, brightness: 1.2, glow: 1.25, speed: 0.78 },
  { keywords: ["금속", "철", "기계", "크롬"], hue: 214, saturation: 0.38, brightness: 1, glow: 0.65, speed: 1.08 },
  { keywords: ["불", "열기", "용광로", "폭발"], hue: 15, saturation: 0.95, brightness: 1.35, glow: 1.9, speed: 1.55 },
  { keywords: ["안개", "꿈", "몽환", "구름", "부유"], hue: 270, saturation: 0.58, brightness: 1, glow: 2.15, speed: 0.48 },
  { keywords: ["글리치", "오류", "디지털", "사이버"], hue: 180, saturation: 0.92, brightness: 1.3, glow: 1.8, speed: 1.75 },
  { keywords: ["레트로", "빈티지", "80년대", "90년대"], hue: 35, saturation: 0.72, brightness: 1.05, glow: 0.85, speed: 0.72 },
  { keywords: ["심연", "암흑", "그림자", "밤"], hue: 245, saturation: 0.72, brightness: 0.72, glow: 1.15, speed: 0.55 },
  { keywords: ["베이스", "콘트라베이스", "저음"], hue: 205, saturation: 0.82, brightness: 0.8, glow: 1.25, speed: 0.82 },
  { keywords: ["피아노", "건반", "키보드"], hue: 42, saturation: 0.5, brightness: 1.18, glow: 1.05, speed: 1.15 },
  { keywords: ["신스", "패드", "지속 화음"], hue: 282, saturation: 0.7, brightness: 1.02, glow: 2.1, speed: 0.48 },
  { keywords: ["드럼", "퍼커션", "타악"], hue: 12, saturation: 0.88, brightness: 1.16, glow: 1.35, speed: 1.55 },
  { keywords: ["기타", "현악", "바이올린", "첼로"], hue: 28, saturation: 0.66, brightness: 1.04, glow: 1.15, speed: 0.92 },
  { keywords: ["보컬", "목소리", "합창"], hue: 338, saturation: 0.62, brightness: 1.14, glow: 1.75, speed: 0.78 },
  { keywords: ["색소폰", "트럼펫", "관악", "브라스"], hue: 52, saturation: 0.78, brightness: 1.16, glow: 1.35, speed: 1.08 }
];

function getVisualProfile(wordOrToken, activeOverride = null) {
  if (wordOrToken && typeof wordOrToken === "object" && Number.isFinite(Number(wordOrToken.hue))) {
    return {
      hue: Number(wordOrToken.hue),
      saturation: Number(wordOrToken.saturation) || 0.72,
      brightness: Number(wordOrToken.brightness) || 1,
      glow: Number(wordOrToken.glow) || 1,
      speed: Number(wordOrToken.speed) || 1,
      scale: Number(wordOrToken.scale) || 1,
      weight: Number(wordOrToken.weight) || 0.5
    };
  }

  const text = String(
    wordOrToken && typeof wordOrToken === "object" ? wordOrToken.text || "" : wordOrToken || ""
  ).toLowerCase();
  for (const profile of VISUAL_DICTIONARY) {
    if (profile.keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
      return { ...profile, scale: 1, weight: 0.5 };
    }
  }

  const active = activeOverride || getActiveVisualProfile?.() || { primaryHue: 280, saturation: 0.75 };
  return {
    hue: (active.primaryHue + (Math.random() - 0.5) * 70 + 360) % 360,
    saturation: active.saturation || 0.75,
    brightness: 1,
    glow: 1,
    speed: 1,
    scale: 1,
    weight: 0.5
  };
}
