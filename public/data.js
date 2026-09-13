// ============================================================
// SAM ALQUIMIA ASTRAL — Datos de la app
// Cuando conectemos AstroAPI, este archivo se reemplaza por
// datos reales sin tocar el diseño en index.html.
// ============================================================

// ---- Temporadas zodiacales del año (fechas aproximadas, no cambian con el año) ----
const ZODIAC_SEASONS = [
  { sign: 'Capricornio', emoji: '🐐', start: [12, 22], end: [1, 19] },
  { sign: 'Acuario',     emoji: '🏺', start: [1, 20],  end: [2, 18] },
  { sign: 'Piscis',      emoji: '🐟', start: [2, 19],  end: [3, 20] },
  { sign: 'Aries',       emoji: '🐏', start: [3, 21],  end: [4, 19] },
  { sign: 'Tauro',       emoji: '🐂', start: [4, 20],  end: [5, 20] },
  { sign: 'Géminis',     emoji: '👯', start: [5, 21],  end: [6, 20] },
  { sign: 'Cáncer',      emoji: '🦀', start: [6, 21],  end: [7, 22] },
  { sign: 'Leo',         emoji: '🦁', start: [7, 23],  end: [8, 22] },
  { sign: 'Virgo',       emoji: '🌾', start: [8, 23],  end: [9, 22] },
  { sign: 'Libra',       emoji: '⚖️', start: [9, 23],  end: [10, 22] },
  { sign: 'Escorpio',    emoji: '🦂', start: [10, 23], end: [11, 21] },
  { sign: 'Sagitario',   emoji: '🏹', start: [11, 22], end: [12, 21] },
];

// Eventos astronómicos clave de 2026 (verificados) — se actualizan una vez al año
const KEY_DATES_2026 = {
  equinoccioOtono: new Date('2026-09-23T00:06:00Z'),   // entrada a Libra
  solsticioInvierno: new Date('2026-12-21T00:00:00Z'), // entrada a Capricornio (aprox.)
};

function getCurrentSeason(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return ZODIAC_SEASONS.find(s => {
    const [sm, sd] = s.start, [em, ed] = s.end;
    if (sm === em) return m === sm && d >= sd && d <= ed;
    if (sm < em) return (m === sm && d >= sd) || (m === em && d <= ed) || (m > sm && m < em);
    // cruza fin de año (Capricornio)
    return (m === sm && d >= sd) || (m === em && d <= ed) || m > sm || m < em;
  });
}

function getNextSeasonChange(date = new Date()) {
  const current = getCurrentSeason(date);
  const idx = ZODIAC_SEASONS.indexOf(current);
  const next = ZODIAC_SEASONS[(idx + 1) % ZODIAC_SEASONS.length];
  const year = date.getFullYear();
  let changeDate = new Date(year, next.start[0] - 1, next.start[1]);
  if (changeDate < date) changeDate = new Date(year + 1, next.start[0] - 1, next.start[1]);
  const days = Math.ceil((changeDate - date) / (1000 * 60 * 60 * 24));
  return { next, days, changeDate };
}

// ---- Perfil actual y cartas guardadas ----
const APP_DATA = {
  user: { name: 'Mariana', initials: 'M' },

  savedCharts: [
    { initials: 'M', label: 'Mariana' },
    { initials: 'R', label: 'Rosa (mamá)' },
    { initials: 'D', label: 'David' },
    { initials: 'L', label: 'Lupita' },
  ],
  maxCharts: 8,

  planets: [
    { g:'☉', label:'Sol', sign:'Virgo', el:'tierra', text:'Tu identidad se construye a través del hacer bien las cosas. Necesitas sentirte útil y ordenada para sentirte tú misma.' },
    { g:'↑', label:'Ascendente', sign:'Libra', el:'aire', text:'La primera impresión que das es diplomática y estética. Buscas equilibrio antes de tomar partido.' },
    { g:'☽', label:'Luna', sign:'Escorpio', el:'agua', text:'Sientes en profundidad y no en superficie. Necesitas confianza real antes de mostrar tu mundo emocional.' },
    { g:'☿', label:'Mercurio', sign:'Virgo', el:'tierra', text:'Piensas en pasos concretos. Detectas el detalle que a otros se les escapa.' },
    { g:'♀', label:'Venus', sign:'Leo', el:'fuego', text:'Amas con generosidad y quieres ser vista. El reconocimiento en el cariño te importa más de lo que admites.' },
    { g:'♂', label:'Marte', sign:'Cáncer', el:'agua', text:'Defiendes lo tuyo desde el instinto de proteger, no desde la confrontación directa.' },
    { g:'♃', label:'Júpiter', sign:'Piscis', el:'agua', text:'Tu fe crece cuando sueltas el control. La intuición te expande más que la planeación.' },
    { g:'♄', label:'Saturno', sign:'Sagitario', el:'fuego', text:'Tu disciplina se construye alrededor de creencias y una visión de largo plazo, no de reglas ajenas.' },
    { g:'☊', label:'Nodo Norte', sign:'Aries', el:'fuego', text:'Tu camino de crecimiento pide más iniciativa propia y menos esperar el momento perfecto.' },
    { g:'MC', label:'Medio Cielo', sign:'Tauro', el:'tierra', text:'Tu vocación se construye con constancia; el reconocimiento profesional llega despacio pero dura.' },
  ],

  horoscopeByProfile: {
    Mariana: [
      { title: 'Presta atención a los detalles', text: 'Antes de responder algo importante, léelo dos veces. Hay matices que se te pueden escapar hoy.' },
      { title: 'Tu intuición está más despierta', text: 'Confía en la primera impresión que tengas de una persona o situación nueva.' },
    ],
    Rosa: [
      { title: 'Un buen día para el descanso', text: 'No fuerces nada hoy — deja que las cosas avancen a su propio ritmo.' },
    ],
    David: [
      { title: 'Conversación pendiente', text: 'Hay algo que llevas tiempo queriendo decir. Hoy el momento se siente más fácil.' },
    ],
  },

  transitosGenerales: [
    { title: 'Júpiter en Leo (hasta julio 2027)', text: 'Un ciclo largo de expansión, creatividad y protagonismo — buen momento para crecer un proyecto propio.' },
    { title: 'Próxima temporada de eclipses: febrero 2027', text: 'Un eclipse solar y uno lunar marcarán cierres e inicios importantes — te avisaremos con tiempo.' },
    { title: 'Luna llena este mes en Piscis', text: 'Momento de soltar lo que ya cumplió su ciclo, sobre todo en temas emocionales o creativos.' },
  ],

  tarotDelDia: { name: 'La Templanza', text: 'Un momento para mezclar en lugar de elegir un extremo. Paciencia antes que impulso.' },

  // Ciclo lunar personalizado: cruza la luna del momento con la carta natal
  // (datos de ejemplo — con AstroAPI esto se calcula en tiempo real)
  lunarCycle: {
    phase: 'Luna Nueva',
    emoji: '🌑',
    rangeText: '10/09 a 18/09',
    nextText: 'Próxima el 18/09 a las 15:44',
    degree: '13°',
    sign: 'Libra',
    intro: 'Estamos en Luna Nueva desde el 10 de septiembre — una fase que invita a sembrar intenciones, no a forzar resultados todavía.',
    natalHighlight: 'Esta Luna Nueva cae casi exacta sobre tu Ascendente natal en Libra: por eso se siente especialmente propicia para ti, no es una casualidad genérica del calendario.',
    aspectsToNatal: [
      { aspect: 'Trígono', target: 'tu Ascendente natal (Libra)', orb: '1.2°', tone: 'favorable' },
      { aspect: 'Sextil', target: 'tu Sol natal (Virgo)', orb: '3.4°', tone: 'favorable' },
      { aspect: 'Cuadratura', target: 'tu Luna natal (Escorpio)', orb: '5.8°', tone: 'tenso' },
    ],
    howToUseIt: 'Aprovéchala para dar el primer paso en algo relacionado con tu imagen o cómo te presentas al mundo — tu marca, tu perfil, tu tienda. La cuadratura con tu Luna natal puede traer algo de resistencia emocional al cambio: no la ignores, pero tampoco dejes que te detenga.',
  },

  mejoresDias: [
    { icon:'✂️', title:'Cortarte el cabello', when:'Luna creciente en Tauro o Leo', text:'Se asocia con crecimiento más rápido y con más volumen.' },
    { icon:'🎨', title:'Tatuarte', when:'Luna menguante, evitando Escorpio', text:'Tradicionalmente se prefiere para mejor cicatrización y menos sensibilidad.' },
    { icon:'🚀', title:'Lanzar tu negocio o producto', when:'Luna nueva o creciente en tu signo', text:'Energía de inicio: ideal para anunciar algo y que tome impulso.' },
    { icon:'💳', title:'Pedir un crédito', when:'Luna creciente en Tauro o Capricornio', text:'Se asocia con estabilidad y compromisos que crecen de forma sólida.' },
    { icon:'🩺', title:'Cirugías', when:'Luna menguante, evitando Luna llena', text:'La tradición sugiere menguante para recuperaciones más tranquilas.' },
  ],

  // Astrocartografía / reubicación — diferenciador para público migrante
  // (contenido de ejemplo — con una API de astrocartografía real esto se calcula por coordenadas)
  astrocartography: {
    birthplace: 'Ciudad de México',
    currentPlace: 'Mérida, México',
    intro: 'Naciste en Ciudad de México, pero hoy vives en Mérida. Tu carta natal no cambia — pero el lugar donde vives sí activa distintas líneas planetarias, y eso influye en cómo se te vive la vida ahí.',
    lines: [
      { planet: 'Júpiter', angle: 'Medio Cielo', emoji: '🚀', category: 'Carrera y crecimiento', note: 'Mérida está cerca de tu línea de Júpiter en el Medio Cielo: buen lugar para que tu proyecto propio crezca y sea reconocido.' },
      { planet: 'Luna', angle: 'Fondo de Cielo', emoji: '🏠', category: 'Sentirte en casa', note: 'También está cerca de tu línea lunar del IC, lo que explica por qué, aunque migraste, Mérida se siente hogareña para ti.' },
      { planet: 'Venus', angle: 'Descendente', emoji: '💗', category: 'Amor y vínculos', note: 'Tu línea de Venus está lejos de aquí — no significa que no puedas tener amor en Mérida, pero si buscas magnetismo romántico extra, esa energía se activa más en otras ciudades.' },
    ],
  },
};
