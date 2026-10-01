// ============================================================
// SAM ALQUIMIA ASTRAL — Servidor (el "cerebro" de la app)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---- Efemérides propias (sin depender de la API externa ni gastar créditos) ----
// Se usan SOLO para saber en qué signo está cada planeta cada día del mes, y así
// detectar ingresos (cambios de signo) con precisión astronómica real (algoritmo de
// Meeus, capítulo 33 — el mismo que usa cualquier software de astrología serio).
const { julian, planetposition } = require('astronomia');
const baseAstro = require('astronomia/base');
const apparentAstro = require('astronomia/apparent');
const nutationAstro = require('astronomia/nutation');
const VSOP_MERCURY = require('astronomia/data/vsop87Bmercury').default;
const VSOP_VENUS = require('astronomia/data/vsop87Bvenus').default;
const VSOP_EARTH = require('astronomia/data/vsop87Bearth').default;
const VSOP_MARS = require('astronomia/data/vsop87Bmars').default;
const VSOP_JUPITER = require('astronomia/data/vsop87Bjupiter').default;
const VSOP_SATURN = require('astronomia/data/vsop87Bsaturn').default;
const VSOP_URANUS = require('astronomia/data/vsop87Buranus').default;
const VSOP_NEPTUNE = require('astronomia/data/vsop87Bneptune').default;

const PLANETAS_VSOP = {
  Mercurio: VSOP_MERCURY, Venus: VSOP_VENUS, Marte: VSOP_MARS, Júpiter: VSOP_JUPITER,
  Saturno: VSOP_SATURN, Urano: VSOP_URANUS, Neptuno: VSOP_NEPTUNE,
};
const SIGNOS_12 = ['Aries','Tauro','Géminis','Cáncer','Leo','Virgo','Libra','Escorpio','Sagitario','Capricornio','Acuario','Piscis'];

// Longitud eclíptica geocéntrica aparente de un planeta (Meeus cap. 33) — de aquí sale el signo.
function longitudEclipticaGrados(datosVSOP, jde) {
  const tierra = new planetposition.Planet(VSOP_EARTH);
  const planeta = new planetposition.Planet(datosVSOP);
  const posTierra = tierra.position(jde);
  const [L0, B0, R0] = [posTierra.lon, posTierra.lat, posTierra.range];
  const [sB0, cB0] = baseAstro.sincos(B0);
  const [sL0, cL0] = baseAstro.sincos(L0);
  let x, y, z;
  function calcular(tau) {
    const pos = planeta.position(jde - tau);
    const [L, B, R] = [pos.lon, pos.lat, pos.range];
    const [sB, cB] = baseAstro.sincos(B);
    const [sL, cL] = baseAstro.sincos(L);
    x = R * cB * cL - R0 * cB0 * cL0;
    y = R * cB * sL - R0 * cB0 * sL0;
    z = R * sB - R0 * sB0;
  }
  calcular(0);
  const delta = Math.sqrt(x * x + y * y + z * z);
  const tau = baseAstro.lightTime(delta);
  calcular(tau);
  let lambda = Math.atan2(y, x);
  const beta = Math.atan2(z, Math.hypot(x, y));
  const [dLambda, dBeta] = apparentAstro.eclipticAberration(lambda, beta, jde);
  const fk5 = planetposition.toFK5(lambda + dLambda, beta + dBeta, jde);
  lambda = fk5.lon;
  const [dPsi] = nutationAstro.nutation(jde);
  lambda += dPsi;
  return ((lambda * 180 / Math.PI) % 360 + 360) % 360;
}
function signoDeGrados(grados) {
  return SIGNOS_12[Math.floor(grados / 30)];
}
// Calcula, para un planeta y un mes/año, en qué días (si los hay) cambia de signo.
// Devuelve como máximo un evento por cambio real detectado (comparando día por día al mediodía UTC).
function ingresosDelMesPorEfemerides(anio, mes, diasEnMes) {
  const eventos = [];
  Object.entries(PLANETAS_VSOP).forEach(([nombrePlaneta, datosVSOP]) => {
    let signoAnterior = null;
    for (let dia = 1; dia <= diasEnMes; dia++) {
      const jde = julian.CalendarGregorianToJD(anio, mes, dia + 0.5); // mediodía UTC
      const grados = longitudEclipticaGrados(datosVSOP, jde);
      const signoHoy = signoDeGrados(grados);
      if (signoAnterior && signoHoy !== signoAnterior) {
        eventos.push({
          fecha: `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
          planeta: nombrePlaneta,
          signo_nuevo: signoHoy,
        });
      }
      signoAnterior = signoHoy;
    }
  });
  return eventos;
}

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.json()(req, res, next);
});
// El index.html NUNCA debe guardarse en caché del navegador — así cada carga siempre
// pide la versión más reciente al servidor, en vez de quedarse atascado en una vieja.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static('public'));

// ---- Caché en memoria con limpieza automática ----
const memoriaCache = new Map();
function cacheGet(clave) {
  const item = memoriaCache.get(clave);
  if (!item) return null;
  if (Date.now() > item.expira) { memoriaCache.delete(clave); return null; }
  return item.valor;
}
function cacheSet(clave, valor, ttlMs) {
  memoriaCache.set(clave, { valor, expira: Date.now() + ttlMs });
}
function cacheHash(...partes) {
  return crypto.createHash('md5').update(partes.join('|')).digest('hex').slice(0, 12);
}

const NOMBRES_MES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const SIGNOS_ES_INGRESO = { Ari:'Aries', Tau:'Tauro', Gem:'Géminis', Can:'Cáncer', Leo:'Leo', Vir:'Virgo', Lib:'Libra', Sco:'Escorpio', Sag:'Sagitario', Cap:'Capricornio', Aqu:'Acuario', Pis:'Piscis' };

// Corrige la fase lunar cuando queda inconsistente con el % de iluminación
// (la API a veces ya marca "menguante"/"creciente" por ángulo mientras la luz
// sigue casi al 100% o casi al 0%, lo cual se lee como contradicción en la app).
function faseCoherente(fase, iluminacionPct) {
  if (iluminacionPct === undefined || iluminacionPct === null) return fase;
  if (iluminacionPct >= 97) return 'Full Moon';
  if (iluminacionPct <= 3) return 'New Moon';
  return fase;
}

// Limpieza automática cada 10 min — evita fugas de memoria
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, item] of memoriaCache.entries()) {
    if (ahora > item.expira) memoriaCache.delete(clave);
  }
}, 10 * 60 * 1000);

const TTL = {
  PERFIL: 5 * 60 * 1000,                 // 5 min
  TRANSITOS_HOY: 30 * 60 * 1000,         // 30 min (compartida entre usuarios)
  LUNA: 30 * 60 * 1000,                  // 30 min
  HOROSCOPO: 2 * 60 * 60 * 1000,         // 2 hrs (cambia poco en el día)
  ENERGIA_DIA: 25 * 60 * 60 * 1000,      // 25 hrs — la clave de caché ya es por día completo (hoyStr()), así que solo el primer cálculo del día es lento; el resto del día responde instantáneo desde caché
  TRANSITOS_PERSONALES: 2 * 60 * 60 * 1000, // 2 hrs
  ECLIPSES: 48 * 60 * 60 * 1000,         // 48 hrs (cambian muy poco)
  CALENDARIO_LUNAR: 12 * 60 * 60 * 1000, // 12 hrs
  ASTROCARTOGRAFIA: 24 * 60 * 60 * 1000, // 24 hrs (estática basada en nacimiento)
  NUMEROLOGIA: 24 * 60 * 60 * 1000,      // 24 hrs (día personal cambia a medianoche)
  ESTRELLAS: 7 * 24 * 60 * 60 * 1000,    // 7 días (prácticamente estática)
};

// Helper: obtener hoy en formato YYYY-MM-DD para claves de caché
const hoyStr = () => new Date().toISOString().slice(0, 10);
const horaStr = () => new Date().toISOString().slice(0, 13);

app.get('/', (req, res) => {
  res.json({ estado: 'Sam Alquimia Astral backend funcionando ✅', prueba: '/probar.html' });
});

// ---- Conexión a Supabase ----
// Cliente ADMIN real: usa la clave de rol de servicio, que se salta las políticas
// de seguridad (RLS). Se usa solo en el servidor, nunca se manda al navegador.
// Si SUPABASE_SERVICE_ROLE_KEY no está configurada, cae de vuelta a la anónima
// (para no tronar la app), pero entonces seguirá topándose con RLS igual que antes.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ---- Conexión a Stripe (cobros) ----
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---- Conexión a Astrology API ----
// Traduce una lista de textos al español con Claude (mucho más confiable que reemplazos de palabras sueltas).
// Si falla, regresa los textos originales sin tronar la sección.
async function traducirBloque(lista) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('traducirBloque: falta ANTHROPIC_API_KEY en las variables de entorno');
    return { textos: lista, debug: 'Falta la variable de entorno ANTHROPIC_API_KEY en Render.' };
  }
  try {
    const prompt = `Estos son textos de astrología. Algunos ya vienen en español y otros en inglés — no importa cuál sea el caso de cada uno. Tu tarea es reescribir CADA texto en español natural de México/Latinoamérica, cálido y profesional, nunca genérico ni de manual técnico (sin modismos de España como "vosotros" o "vale", y sin traducción literal palabra por palabra si ya viene en español — mejóralo, no lo dejes igual). Responde ÚNICAMENTE con un array JSON de strings, en el mismo orden, sin explicación ni markdown:\n\n${JSON.stringify(lista)}`;
    const controlador = new AbortController();
    const timeoutId = setTimeout(() => controlador.abort(), 40000);
    const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
      signal: controlador.signal,
    });
    clearTimeout(timeoutId);
    const datos = await respuesta.json();
    if (!respuesta.ok) {
      console.error('traducirBloque: Anthropic respondió', respuesta.status, JSON.stringify(datos).slice(0, 800));
      return { textos: lista, debug: `Anthropic respondió ${respuesta.status}: ${JSON.stringify(datos).slice(0, 500)}` };
    }
    let texto = (datos.content?.[0]?.text || '[]').trim();
    texto = texto.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const inicio = texto.indexOf('[');
    const fin = texto.lastIndexOf(']');
    if (inicio !== -1 && fin !== -1 && fin > inicio) texto = texto.slice(inicio, fin + 1);
    let traducidos;
    try {
      traducidos = JSON.parse(texto);
    } catch (eParse) {
      console.error('traducirBloque: no se pudo parsear. Texto crudo:', texto.slice(0, 800));
      return { textos: lista, debug: `No se pudo parsear como JSON. Texto crudo: ${texto.slice(0, 500)}` };
    }
    if (!Array.isArray(traducidos) || traducidos.length !== lista.length) {
      console.error('traducirBloque: tamaño no coincide. Esperado', lista.length, 'recibido', Array.isArray(traducidos) ? traducidos.length : typeof traducidos);
      return { textos: lista, debug: `Array no coincide en tamaño. Esperado ${lista.length}, recibido ${Array.isArray(traducidos) ? traducidos.length : typeof traducidos}` };
    }
    return { textos: traducidos, debug: null };
  } catch (e) {
    console.error('traducirBloque falló:', e.message);
    return { textos: lista, debug: 'Excepción: ' + e.message };
  }
}

// Traduce una lista completa dividiéndola en bloques de 25 (respuestas grandes como
// sinastría pueden traer 60+ textos, y un solo bloque gigante es más frágil/lento)
async function traducirTextosConIA(textos) {
  const lista = (textos || []).filter(t => t && typeof t === 'string');
  if (!lista.length) return { textos: [], debug: 'sin textos que traducir' };
  const TAMANO_BLOQUE = 12;
  const bloques = [];
  for (let i = 0; i < lista.length; i += TAMANO_BLOQUE) bloques.push(lista.slice(i, i + TAMANO_BLOQUE));
  const resultados = await Promise.all(bloques.map(traducirBloque));
  const textosFinal = resultados.flatMap(r => r.textos);
  const primerError = resultados.find(r => r.debug)?.debug || null;
  return { textos: textosFinal, debug: primerError };
}

// Busca CUALQUIER campo de texto interpretativo (interpretation, description, meaning,
// summary, advice, judgment) en cualquier nivel anidado de una respuesta, y lo traduce
// con IA en el mismo lugar. Así no dependemos de conocer la forma exacta de cada endpoint.
const CAMPOS_INTERPRETATIVOS = ['interpretation', 'description', 'meaning', 'summary', 'advice', 'judgment', 'answer', 'text', 'narrative', 'analysis'];

// Detecta si un texto está en inglés (palabras clave comunes)
function esTextoEnIngles(texto) {
  if (!texto || typeof texto !== 'string') return false;
  const palabrasIngles = ['the', 'and', 'is', 'are', 'to', 'of', 'in', 'on', 'at', 'this', 'that', 'with', 'for', 'from'];
  const palabrasPortugues = ['que', 'para', 'uma', 'através', 'entre', 'com', 'por', 'dos', 'das', 'pelo', 'pela', 'enocionais', 'harmoniosa', 'capacidade', 'facilidade', 'através', 'nutrir', 'transformam', 'alimentam', 'expressar', 'satisfazen'];
  const palabrasSpanish = ['el', 'la', 'y', 'es', 'están', 'de', 'en', 'con', 'para', 'por', 'este', 'ese', 'que', 'entre', 'sus', 'los', 'las'];
  const textLower = texto.toLowerCase();
  const countEng = palabrasIngles.filter(p => textLower.includes(' ' + p + ' ')).length;
  const countPt = palabrasPortugues.filter(p => textLower.includes(p)).length;
  const countEs = palabrasSpanish.filter(p => textLower.includes(' ' + p + ' ')).length;
  // Traducir si está en inglés O en portugués
  if (countPt >= 2) return true;
  return countEng > countEs;
}

async function traducirInterpretacionesEnObjeto(raiz) {
  const objetos = [];
  function buscar(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(buscar); return; }
    for (const campo of CAMPOS_INTERPRETATIVOS) {
      if (typeof obj[campo] === 'string' && obj[campo].trim().length > 3) objetos.push({ obj, campo });
    }
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') buscar(obj[key]);
    }
  }
  buscar(raiz);
  if (!objetos.length) return 0;

  // Siempre traducir — la API puede mandar inglés, portugués o mezcla
  // El costo es mínimo comparado con mostrar texto en idioma incorrecto
  const textosPorTraducir = objetos.map(o => o.obj[o.campo]);
  const { textos: traducidos } = await traducirTextosConIA(textosPorTraducir);
  objetos.forEach((o, i) => { if (traducidos[i]) o.obj[o.campo] = traducidos[i]; });
  return objetos.length;
}

// Toma los 40-70 fragmentos técnicos crudos de la carta natal (planeta+signo, planeta+casa,
// aspectos) y los sintetiza en 10 bloques de personalidad integrados, en español simple,
// siguiendo las reglas del documento de producto: sin absolutos, 80-160 palabras cada uno,
// integrando varios factores en vez de solo concatenar "Sol en X + Luna en Y".
const CATEGORIAS_PERSONALIDAD = [
  ['mi_esencia', 'Mi esencia'], ['mis_emociones', 'Mis emociones'],
  ['como_pienso', 'Cómo pienso y me comunico'], ['como_amo', 'Cómo amo'],
  ['como_actuo', 'Cómo actúo'], ['trabajo_vocacion', 'Trabajo y vocación'],
  ['dinero_seguridad', 'Dinero y seguridad'], ['mis_relaciones', 'Mis relaciones'],
  ['mis_fortalezas', 'Mis fortalezas'], ['mis_retos', 'Mis retos y crecimiento'],
];
async function sintetizarPersonalidad10Bloques(interpretaciones) {
  const fragmentos = (interpretaciones || [])
    .filter(i => i.text && i.title)
    .map(i => `${i.title}: ${i.text}`)
    .join('\n\n');
  if (!fragmentos.trim()) return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const listaCategorias = CATEGORIAS_PERSONALIDAD.map(([clave, nombre]) => `- ${clave}: "${nombre}"`).join('\n');
  const prompt = `Eres una astróloga profesional escribiendo un análisis de personalidad en español de México/Latinoamérica, cálido pero profesional, para alguien SIN conocimientos de astrología.

Con base ÚNICAMENTE en estos datos técnicos reales de la carta natal (no inventes nada que no esté aquí):

${fragmentos}

Escribe una síntesis integrada en exactamente estas 10 categorías. Cada bloque debe INTEGRAR varios factores relevantes en una narrativa fluida (nunca "Sol en X + Luna en Y", sino un texto que combine y resuelva lo que esos factores dicen juntos). Usa lenguaje de tendencia ("tiende a", "puede", "suele notar"), nunca absolutos ("siempre", "nunca", "te va a pasar"). Cada bloque debe tener entre 80 y 160 palabras.

Categorías (usa exactamente estas llaves):
${listaCategorias}

Responde ÚNICAMENTE con un objeto JSON con esas 10 llaves exactas, cada una con el texto de ese bloque. Sin explicación ni markdown.`;

  try {
    const controlador = new AbortController();
    const timeoutId = setTimeout(() => controlador.abort(), 40000);
    const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
      signal: controlador.signal,
    });
    clearTimeout(timeoutId);
    const datos = await respuesta.json();
    if (!respuesta.ok) {
      console.error('sintetizarPersonalidad10Bloques: Anthropic respondió', respuesta.status, JSON.stringify(datos).slice(0, 500));
      return { _error: `Anthropic respondió ${respuesta.status}` };
    }
    let texto = (datos.content?.[0]?.text || '{}').trim();
    texto = texto.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const inicio = texto.indexOf('{');
    const fin = texto.lastIndexOf('}');
    if (inicio !== -1 && fin !== -1) texto = texto.slice(inicio, fin + 1);
    return JSON.parse(texto);
  } catch (e) {
    console.error('sintetizarPersonalidad10Bloques falló:', e.message);
    return { _error: e.message };
  }
}

const astrologyApi = axios.create({
  baseURL: process.env.ASTROLOGY_API_BASE_URL,
  timeout: 45000, // 45s — suficiente incluso para cálculos pesados (astrocartografía), pero sigue evitando que la app se quede colgada para siempre
  headers: {
    Authorization: `Bearer ${process.env.ASTROLOGY_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ============================================================
// Middleware: verifica que la usuaria haya iniciado sesión
// ============================================================
async function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'No iniciaste sesión.' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Sesión inválida o expirada.' });

  req.userId = data.user.id;
  req.userEmail = data.user.email;
  req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  next();
}

// Middleware para rutas Premium — verifica suscripción activa en la base de datos
async function requirePremium(req, res, next) {
  try {
    const { data: sub } = await supabase.from('subscriptions').select('estado').eq('user_id', req.userId).maybeSingle();
    // También permitir acceso al email admin (para que tú puedas probar todo)
    const esAdmin = req.userEmail === (process.env.ADMIN_EMAIL || 'shernsndez.22@gmail.com');
    if (!esAdmin && sub?.estado !== 'activa') {
      return res.status(403).json({ error: 'Esta función requiere una suscripción activa.', premium_required: true });
    }
    next();
  } catch (err) {
    next(); // Si falla la verificación, dejamos pasar (mejor experiencia que bloquear)
  }
}

// Helper: arma el objeto subject.birth_data a partir del perfil guardado
function birthDataDesdePerfil(perfil, nombre) {
  const [anio, mes, dia] = perfil.fecha_nacimiento.split('-').map(Number);
  const [hora, minuto] = (perfil.hora_nacimiento || '12:00').split(':').map(Number);
  const birthData = {
    year: anio, month: mes, day: dia, hour: hora, minute: minuto, second: 0,
    city: perfil.ciudad_nacimiento,
    country_code: perfil.pais_codigo,
  };
  // Si ya tenemos coordenadas exactas (del buscador de ciudades), las mandamos también —
  // así la API no depende de adivinar la ubicación solo por el nombre escrito.
  if (typeof perfil.latitud === 'number' && !isNaN(perfil.latitud)) birthData.latitude = perfil.latitud;
  if (typeof perfil.longitud === 'number' && !isNaN(perfil.longitud)) birthData.longitude = perfil.longitud;
  return {
    name: nombre || perfil.nombre || 'Usuaria',
    birth_data: birthData,
  };
}

async function leerPerfil(req) {
  const clave = cacheHash('perfil', req.userId);
  const cached = cacheGet(clave);
  if (cached) return cached;
  const { data: perfil, error } = await req.supabase
    .from('profiles')
    .select('*')
    .eq('id', req.userId)
    .single();
  if (error || !perfil) return null;
  cacheSet(clave, perfil, 5 * 60 * 1000); // 5 min
  return perfil;
}

// ============================================================
// RUTA: Registro de nueva usuaria
// ============================================================
app.post('/auth/registro', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password, nombre } = req.body;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { nombre: nombre || null } },
  });
  if (error) {
    // Traduce el mensaje más común de Supabase para que sea claro en español
    if (/already registered|already exists|already in use/i.test(error.message)) {
      return res.status(400).json({ error: 'Ese correo ya tiene una cuenta. Inicia sesión, o usa "¿Olvidaste tu contraseña?" si no la recuerdas.' });
    }
    return res.status(400).json({ error: error.message });
  }
  // Por seguridad, Supabase a veces NO marca error cuando el correo ya existe —
  // en su lugar regresa un usuario con identities: [] (vacío). Lo detectamos aquí.
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return res.status(400).json({ error: 'Ese correo ya tiene una cuenta. Inicia sesión, o usa "¿Olvidaste tu contraseña?" si no la recuerdas.' });
  }
  res.json({ mensaje: 'Cuenta creada', usuario: data.user });
});

// ============================================================
// RUTA: Inicio de sesión
// ============================================================
app.post('/auth/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ sesion: data.session, usuario: data.user });
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Falta el refresh_token.' });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
  res.json({ sesion: data.session });
});

// ============================================================
// RUTA: Solicitar recuperación de contraseña (envía correo con link)
// ============================================================
app.post('/auth/olvide-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Falta el correo.' });
  const urlBase = process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${urlBase}/restablecer.html`,
  });
  // Por seguridad, siempre respondemos "ok" aunque el correo no exista (evita revelar qué correos están registrados)
  if (error) console.error('Error al enviar correo de recuperación:', error.message);
  res.json({ mensaje: 'Si ese correo está registrado, te enviamos un enlace para restablecer tu contraseña.' });
});

// ============================================================
// RUTA: Completar el restablecimiento con el token que llega en el link del correo
// ============================================================
// ============================================================
// RUTA: Cambiar contraseña estando ya conectada (sin pasar por correo).
// Verifica primero la contraseña actual, por seguridad, antes de cambiarla.
// ============================================================
app.post('/auth/cambiar-password', requireLogin, async (req, res) => {
  const { password_actual, nueva_password } = req.body;
  if (!password_actual || !nueva_password) return res.status(400).json({ error: 'Faltan datos.' });
  if (nueva_password.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres.' });

  // Verifica la contraseña actual antes de permitir el cambio
  const { error: errorVerificacion } = await supabase.auth.signInWithPassword({ email: req.userEmail, password: password_actual });
  if (errorVerificacion) return res.status(400).json({ error: 'Tu contraseña actual no es correcta.' });

  const { error } = await req.supabase.auth.updateUser({ password: nueva_password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ mensaje: 'Contraseña actualizada correctamente.' });
});

app.post('/auth/restablecer-password', async (req, res) => {
  const { access_token, nueva_password } = req.body;
  if (!access_token || !nueva_password) return res.status(400).json({ error: 'Faltan datos.' });
  if (nueva_password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${access_token}`,
      },
      body: JSON.stringify({ password: nueva_password }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data.msg || data.error_description || 'No se pudo actualizar la contraseña. El enlace puede haber expirado.' });
    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (e) {
    res.status(500).json({ error: 'Error al actualizar la contraseña.' });
  }
});

// ============================================================
// RUTA: Buscar ciudad con coordenadas reales (evita fallos silenciosos
// cuando el nombre de la ciudad no coincide exacto con lo que la API de
// astrología reconoce por su cuenta)
// ============================================================
app.get('/buscar-ciudad', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ resultados: [] });
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', addressdetails: 1, limit: 6, 'accept-language': 'es' },
      headers: { 'User-Agent': 'SamAlquimiaAstral/1.0 (contacto: shernsndez.22@gmail.com)' },
      timeout: 6000,
    });
    const resultados = (r.data || [])
      .filter(item => {
        const a = item.address || {};
        const esLugarReal = Boolean(a.city || a.town || a.village || a.municipality || a.hamlet);
        return esLugarReal && item.type !== 'state' && item.type !== 'country';
      })
      .map(item => ({
        etiqueta: item.display_name,
        ciudad: item.address?.city || item.address?.town || item.address?.village || item.name,
        pais_codigo: (item.address?.country_code || '').toUpperCase(),
        latitud: parseFloat(item.lat),
        longitud: parseFloat(item.lon),
      }));
    res.json({ resultados });
  } catch (err) {
    console.error('buscar-ciudad falló:', err.message);
    res.json({ resultados: [] });
  }
});

// ============================================================
// RUTA: Guardar/actualizar el perfil (ciudad + país)
// ============================================================
app.post('/perfil', requireLogin, async (req, res) => {
  const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud } = req.body;

  // Leer perfil ANTERIOR para comparar si cambiaron datos de nacimiento
  const { data: perfilAnterior } = await supabase
    .from('profiles')
    .select('fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo')
    .eq('id', req.userId)
    .maybeSingle();

  const datosAGuardar = {
    id: req.userId,
    nombre,
    fecha_nacimiento,
    hora_nacimiento,
    ciudad_nacimiento,
    pais_codigo,
  };
  if (typeof latitud === 'number' && !isNaN(latitud)) datosAGuardar.latitud = latitud;
  if (typeof longitud === 'number' && !isNaN(longitud)) datosAGuardar.longitud = longitud;

  const { data, error } = await req.supabase
    .from('profiles')
    .upsert(datosAGuardar)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Solo invalidar carta natal y cálculos pesados si cambiaron datos de NACIMIENTO.
  // Cambiar solo el nombre NO debe borrar la carta — es costoso recalcularla.
  const cambioDatosNacimiento = !perfilAnterior
    || perfilAnterior.fecha_nacimiento !== fecha_nacimiento
    || perfilAnterior.hora_nacimiento !== hora_nacimiento
    || perfilAnterior.ciudad_nacimiento !== ciudad_nacimiento
    || perfilAnterior.pais_codigo !== pais_codigo;

  const hoy = new Date();
  const anioActual = hoy.getUTCFullYear();
  const mesActual = hoy.getUTCMonth() + 1;

  // Caché de perfil siempre se limpia (el nombre pudo cambiar)
  memoriaCache.delete(cacheHash('perfil', req.userId));

  if (cambioDatosNacimiento) {
    // Datos de nacimiento cambiaron → borrar carta y todos los cálculos derivados
    memoriaCache.delete(cacheHash(req.userId, 'acg', 'propia'));
    memoriaCache.delete(cacheHash(req.userId, 'estrellas', 'propia'));
    memoriaCache.delete(cacheHash(req.userId, 'calendario-lunar', `${anioActual}-${mesActual}`));
    memoriaCache.delete(cacheHash(req.userId, 'home', hoyStr()));
    memoriaCache.delete(cacheHash(req.userId, 'numerologia', 'propia', hoyStr()));
    memoriaCache.delete(cacheHash(req.userId, 'energia', hoyStr()));
    memoriaCache.delete(cacheHash(req.userId, 'horoscopo', hoyStr()));
    memoriaCache.delete(cacheHash(req.userId, 'transitos', horaStr()));
    // Borrar caché persistente de ACG y numerología en Supabase también
    supabase.from('cache_persistente').delete().in('clave', [
      `acg_${req.userId}_propia`,
      `num_${req.userId}_propia`,
    ]).then(() => {}).catch(() => {});
    // Borrar carta natal para que se recalcule con los nuevos datos
    await req.supabase.from('natal_charts').delete().eq('user_id', req.userId);
  }

  res.json({ mensaje: 'Perfil guardado', perfil: data, recalculo_carta: cambioDatosNacimiento });
});

// RUTA: Leer el perfil actual de la usuaria
app.get('/perfil', requireLogin, async (req, res) => {
  const [{ data, error }, { data: sub }, { data: usuarioAuth }] = await Promise.all([
    req.supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle(),
    req.supabase.from('subscriptions').select('estado').eq('user_id', req.userId).maybeSingle(),
    req.supabase.auth.getUser(),
  ]);

  if (error) return res.status(400).json({ error: error.message });
  const nombreSugerido = usuarioAuth?.user?.user_metadata?.nombre || null;
  res.json({ perfil: data, suscripcion: sub?.estado || 'ninguna', nombre_sugerido: nombreSugerido });
});

// ============================================================
// RUTA: Calcular la carta natal REAL (texto: Sol, Luna, etc.)
// ============================================================
app.post('/carta-natal', requireLogin, async (req, res) => {
  try {
    // 1) ¿Ya la calculamos antes? Si sí, la regresamos sin gastar créditos
    const { data: yaExiste } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (yaExiste && !req.body?.forzar) {
      return res.json({ mensaje: 'Carta natal (guardada)', carta: yaExiste, desde_cache: true });
    }

    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: birthDataDesdePerfil(perfil),
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const { data: cartaGuardada, error: errorGuardar } = await req.supabase
      .from('natal_charts')
      .insert({ user_id: req.userId, datos_carta: respuesta.data })
      .select()
      .single();

    if (errorGuardar) return res.status(400).json({ error: errorGuardar.message });

    res.json({ mensaje: 'Carta natal calculada', carta: cartaGuardada, desde_cache: false });
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error('carta-natal falló:', detalle);
    res.status(500).json({ error: 'No se pudo calcular la carta. Revisa los datos de nacimiento.', detalle_tecnico: detalle });
  }
});

// ============================================================
// RUTA: Generar la carta natal VISUAL (la "rueda" en SVG)
// ============================================================
app.post('/carta-visual', requireLogin, async (req, res) => {
  try {
    // 1) Buscamos la carta guardada de esta usuaria
    const { data: cartaExistente } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 2) Si ya tiene el dibujo guardado, lo regresamos sin gastar créditos
    if (cartaExistente?.svg_visual && !req.body?.forzar) {
      return res.json({ svg: cartaExistente.svg_visual, desde_cache: true });
    }

    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const respuesta = await astrologyApi.post('/render/natal', {
      subject: birthDataDesdePerfil(perfil),
      options: { house_system: 'P' },
      render_options: { format: 'svg', theme: 'light' },
    });

    let svg = null;
    const crudoTexto = typeof respuesta.data === 'string' ? respuesta.data : JSON.stringify(respuesta.data);
    const inicioSvg = crudoTexto.indexOf('<svg');
    if (inicioSvg !== -1) {
      svg = crudoTexto.slice(inicioSvg);
    } else if (respuesta.data?.svg_content) {
      svg = respuesta.data.svg_content;
    } else if (respuesta.data?.svg) {
      svg = respuesta.data.svg;
    }

    // 3) Guardamos el dibujo para la próxima vez, si tenemos dónde guardarlo
    if (svg && cartaExistente?.id) {
      await req.supabase.from('natal_charts').update({ svg_visual: svg }).eq('id', cartaExistente.id);
    }

    res.json({ svg, crudo: svg ? undefined : respuesta.data, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// ============================================================
// RUTA: Fase lunar de HOY (real)
// ============================================================
// RUTA: Leer la última carta natal ya calculada (para mostrar Sol/Asc/Luna al abrir la app)
app.get('/carta-natal/ultima', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('natal_charts')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ carta: data });
});

// RUTA: Resumen/reporte de personalidad de la carta natal (en español)
app.post('/resumen-natal', requireLogin, async (req, res) => {
  try {
    const { data: cartaExistente } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cartaExistente?.resumen_cache && !req.body?.forzar) {
      return res.json({ reporte: cartaExistente.resumen_cache, desde_cache: true });
    }

    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const respuesta = await astrologyApi.post('/analysis/natal-report', {
      subject: birthDataDesdePerfil(perfil),
      report_options: { tradition: 'psychological', language: 'es' },
    });

    await traducirInterpretacionesEnObjeto(respuesta.data);

    // OPTIMIZACIÓN (30 sept): Síntesis asincrónica sin bloquear
    const reporteSinSintesis = { ...respuesta.data, sintesis_10: { _generando: true } };
    
    // Responder INMEDIATAMENTE con la carta, sin esperar síntesis
    res.json({ reporte: reporteSinSintesis, desde_cache: false });
    
    // Generar síntesis EN SEGUNDO PLANO (no bloquea al usuario)
    (async () => {
      try {
        const sintesis10 = await sintetizarPersonalidad10Bloques(respuesta.data?.data?.interpretations || []);
        const reporteFinal = { ...respuesta.data, sintesis_10: sintesis10 };
        if (cartaExistente?.id) {
          await req.supabase.from('natal_charts').update({ resumen_cache: reporteFinal }).eq('id', cartaExistente.id);
        }
      } catch (e) {
        console.error('Síntesis de personalidad falló en segundo plano:', e.message);
        // No interrumpe al usuario — la carta ya se mostró
      }
    })();
    
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el resumen.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/luna', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const ahora = new Date();
    const cacheKey = cacheHash(req.userId, horaStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const respuesta = await astrologyApi.post('/analysis/lunar-analysis', {
      datetime_location: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: ahora.getUTCHours(),
        minute: ahora.getUTCMinutes(),
        second: 0,
        city: perfil?.ciudad_nacimiento || 'Mexico City',
        country_code: perfil?.pais_codigo || 'MX',
      },
      report_options: { language: 'es' },
    });

    const respuestaLuna = { mensaje: 'Datos lunares de hoy', luna: respuesta.data };
    await traducirInterpretacionesEnObjeto(respuestaLuna);
    cacheSet(cacheKey, respuestaLuna, TTL.LUNA);
    res.json(respuestaLuna);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({
      error: 'No se pudo obtener la fase lunar.',
      detalle_tecnico: err?.response?.data || err.message,
    });
  }
});

// ============================================================
// RUTA: Luna Vacía de Curso — ventana de hoy (si existe)
// ============================================================
app.post('/luna-vacia', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const ahora = new Date();
    const cacheKey = cacheHash(req.userId, 'luna-vacia', hoyStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const respuesta = await astrologyApi.post('/lunar/void-of-course', {
      datetime_location: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
        city: perfil?.ciudad_nacimiento || 'Mexico City',
        country_code: perfil?.pais_codigo || 'MX',
      },
    });

    const respuestaVoC = { mensaje: 'Luna vacía de hoy', voc: respuesta.data };
    cacheSet(cacheKey, respuestaVoC, TTL.LUNA);
    res.json(respuestaVoC);
  } catch (err) {
    console.error('luna-vacia falló:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'No se pudo obtener la Luna Vacía de Curso.',
      detalle_tecnico: err?.response?.data || err.message,
    });
  }
});

// ============================================================
// RUTA: Astrología Horaria — respuesta a una pregunta específica,
// calculada con la carta del momento exacto en que se pregunta.
// ============================================================
app.post('/horaria', requireLogin, async (req, res) => {
  try {
    const { pregunta } = req.body;
    if (!pregunta || !pregunta.trim()) return res.status(400).json({ error: 'Escribe tu pregunta primero.' });

    const perfil = await leerPerfil(req);
    const ahora = new Date();

    const respuesta = await astrologyApi.post('/horary/ask', {
      question: pregunta.trim(),
      question_time: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: ahora.getUTCHours(),
        minute: ahora.getUTCMinutes(),
        second: 0,
        city: perfil?.ciudad_nacimiento || 'Mexico City',
        country_code: perfil?.pais_codigo || 'MX',
      },
    });

    // Guardamos la pregunta para poder revisarla más adelante, cuando el aspecto se cumpla
    const h = respuesta.data?.data || respuesta.data || {};
    const textoRespuesta = h.answer || h.judgment || h.interpretation || h.text || h.result || null;
    let guardadaId = null;
    try {
      const { data: guardada } = await req.supabase.from('horarias_guardadas').insert({
        user_id: req.userId,
        pregunta: pregunta.trim(),
        respuesta: typeof textoRespuesta === 'string' ? textoRespuesta : null,
      }).select('id').single();
      guardadaId = guardada?.id || null;
    } catch (eGuardar) {
      console.error('No se pudo guardar la pregunta horaria (no es crítico):', eGuardar.message);
    }

    res.json({ mensaje: 'Respuesta horaria', horaria: respuesta.data, guardada_id: guardadaId });
  } catch (err) {
    console.error('horaria falló:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'No se pudo calcular la respuesta horaria.',
      detalle_tecnico: err?.response?.data || err.message,
    });
  }
});

app.get('/horarias-guardadas', requireLogin, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('horarias_guardadas')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ preguntas: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron cargar tus preguntas guardadas.' });
  }
});

app.put('/horarias-guardadas/:id', requireLogin, async (req, res) => {
  try {
    const { nota_revision } = req.body;
    const { data, error } = await req.supabase
      .from('horarias_guardadas')
      .update({ revisada: true, nota_revision: nota_revision || null })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'No se encontró esa pregunta.' });
    res.json({ mensaje: 'Marcada como revisada', pregunta: data });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo actualizar.' });
  }
});

app.delete('/horarias-guardadas/:id', requireLogin, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('horarias_guardadas')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select();
    if (error) return res.status(400).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'No se encontró esa pregunta.' });
    res.json({ mensaje: 'Eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo eliminar.' });
  }
});

// ============================================================
// RUTA: Mensaje del día (Sol/Luna de hoy + tu carta real)
// ============================================================
// ============================================================
// FASE 14 (parcial) — ENDPOINT AGREGADO DEL HOME
// Una sola llamada que devuelve: saludo, luna, tránsito principal,
// día personal y frase del día. Ahorra 3-4 llamadas al cargar la app.
// ============================================================
app.post('/home-summary', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date();
    const cacheKey = cacheHash(req.userId, 'home', hoyStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, nombre: perfil.nombre });

    // Lanzar todas las llamadas en paralelo
    const [lunaData, ciclosData, transitosHoyData] = await Promise.all([
      astrologyApi.post('/analysis/lunar-analysis', {
        datetime_location: {
          year: hoy.getUTCFullYear(), month: hoy.getUTCMonth()+1, day: hoy.getUTCDate(),
          hour: hoy.getUTCHours(), minute: hoy.getUTCMinutes(), second: 0,
          city: perfil.ciudad_nacimiento || 'Mexico City', country_code: perfil.pais_codigo || 'MX',
        },
        report_options: { language: 'es' },
      }).catch(() => null),
      astrologyApi.post('/numerology/personal-cycles', {
        subject: birthDataDesdePerfil(perfil),
        target_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth()+1, day: hoy.getUTCDate() },
        language: 'es',
      }).catch(() => null),
      astrologyApi.post('/charts/natal', {
        subject: { name: 'Hoy', birth_data: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth()+1, day: hoy.getUTCDate(), hour: hoy.getUTCHours(), minute: 0, second: 0, city: 'Greenwich', country_code: 'GB' } },
        options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
      }).catch(() => null),
    ]);

    const luna = lunaData?.data?.data?.lunar_metrics;
    const diaPersonal = ciclosData?.data?.data?.personal_day?.number || null;
    const anioPersonal = ciclosData?.data?.data?.personal_year?.number || null;
    const planetasHoy = transitosHoyData?.data?.subject_data;

    // Detectar eventos especiales del día: un planeta que cambió de signo (ingreso),
    // o que empezó/terminó su retrogradación, comparando contra el snapshot guardado ayer.
    // Esto es igual para todo el mundo (no depende del usuario), por eso se guarda en una
    // tabla global de una sola fila por día.
    let eventosEspeciales = [];
    if (planetasHoy) {
      try {
        const hoyISO = hoy.toISOString().slice(0, 10);
        const { data: filaAyer } = await supabase
          .from('estado_planetario_diario')
          .select('fecha, datos')
          .neq('fecha', hoyISO)
          .order('fecha', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (filaAyer?.datos) {
          const NOMBRES_PLANETA_ES = { sun:'Sol', moon:'Luna', mercury:'Mercurio', venus:'Venus', mars:'Marte', jupiter:'Júpiter', saturn:'Saturno', uranus:'Urano', neptune:'Neptuno', pluto:'Plutón' };
          Object.keys(NOMBRES_PLANETA_ES).forEach(key => {
            const antes = filaAyer.datos[key];
            const ahora = planetasHoy[key];
            if (!antes || !ahora) return;
            const nombreEs = NOMBRES_PLANETA_ES[key];
            // Cambio de signo (ingreso)
            if (antes.sign && ahora.sign && antes.sign !== ahora.sign) {
              eventosEspeciales.push({
                tipo: 'ingreso',
                planeta: nombreEs,
                texto: `${nombreEs} entró hoy a ${SIGNOS_ES_INGRESO[ahora.sign] || ahora.sign}. Es un buen momento para notar cómo cambia la energía de ${nombreEs.toLowerCase()} en tu día a día durante las próximas semanas.`,
              });
            }
            // Cambio de dirección (empezó o terminó retrógrado)
            const antesRetro = !!antes.retrograde;
            const ahoraRetro = !!ahora.retrograde;
            if (antesRetro !== ahoraRetro) {
              eventosEspeciales.push({
                tipo: ahoraRetro ? 'retrogrado_inicio' : 'retrogrado_fin',
                planeta: nombreEs,
                texto: ahoraRetro
                  ? `${nombreEs} se volvió retrógrado hoy. Es un buen momento para revisar, repensar y no forzar decisiones grandes relacionadas con lo que ${nombreEs.toLowerCase()} representa para ti.`
                  : `${nombreEs} volvió a movimiento directo hoy. Lo que estuvo detenido o en revisión relacionado con ${nombreEs.toLowerCase()} puede empezar a avanzar de nuevo.`,
              });
            }
          });
        }

        // Guardar el snapshot de hoy para la comparación de mañana. NO se espera (no lleva
        // "await") porque esto es solo para el día siguiente — no hace falta que la usuaria
        // espere a que termine de guardarse para ver su respuesta, así la pantalla responde
        // más rápido.
        const snapshotHoy = {};
        Object.entries(planetasHoy).forEach(([key, val]) => {
          if (val && val.sign) snapshotHoy[key] = { sign: val.sign, retrograde: !!val.retrograde };
        });
        supabase.from('estado_planetario_diario').upsert({ fecha: hoyISO, datos: snapshotHoy }, { onConflict: 'fecha' })
          .then(() => {}).catch(e => console.error('No se pudo guardar snapshot planetario:', e.message));
      } catch (e) {
        console.error('No se pudo calcular eventos especiales planetarios:', e.message);
      }
    }

    // Extraer el tránsito más importante del día
    let transitoPrincipal = null;
    if (planetasHoy) {
      const PESO = { Pluto:1, Neptune:2, Uranus:3, Saturn:4, Jupiter:5, Mars:6, Venus:7, Mercury:8, Sun:9, Moon:10 };
      const planetaOrdenado = Object.keys(PESO).find(p => planetasHoy[p.toLowerCase()]);
      if (planetaOrdenado) {
        const pos = planetasHoy[planetaOrdenado.toLowerCase()];
        transitoPrincipal = { planeta: planetaOrdenado, signo: pos.sign, grado: pos.position ? Math.floor(pos.position) : null };
      }
    }

    const resumen = {
      luna: luna ? { signo: luna.moon_sign, fase: faseCoherente(luna.moon_phase, luna.moon_illumination), iluminacion: Math.round(luna.moon_illumination), dia_lunar: luna.moon_day } : null,
      dia_personal: diaPersonal,
      anio_personal: anioPersonal,
      transito_principal: transitoPrincipal,
      eventos_especiales: eventosEspeciales,
      hora_local: hoy.getUTCHours(),
    };

    cacheSet(cacheKey, resumen, TTL.ENERGIA_DIA);
    res.json({ ...resumen, nombre: perfil.nombre });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo cargar el resumen del día.' });
  }
});

app.post('/mensaje-del-dia', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const ahora = new Date();
    const cacheKey = cacheHash('transitos-hoy', horaStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, nombre: perfil.nombre });

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: {
        name: 'Hoy',
        birth_data: {
          year: ahora.getUTCFullYear(), month: ahora.getUTCMonth() + 1, day: ahora.getUTCDate(),
          hour: ahora.getUTCHours(), minute: ahora.getUTCMinutes(), second: 0,
          city: 'Greenwich', country_code: 'GB',
        },
      },
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const base = { mensaje: 'Mensaje del día', datos_hoy: respuesta.data };
    cacheSet(cacheKey, base, TTL.TRANSITOS_HOY);
    res.json({ ...base, nombre: perfil.nombre });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el mensaje del día.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// ============================================================
// RUTA: Astrocartografía (mapa mundial de líneas planetarias)
// ============================================================
app.post('/astrocartografia', requireLogin, async (req, res) => {
  try {
    const otraCartaId = req.body?.otra_carta_id || null;
    const cacheKey = cacheHash(req.userId, 'acg', otraCartaId || 'propia');

    // 1) Caché en memoria (respuesta inmediata si el servidor no se reinició)
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // 2) Caché persistente en Supabase (sobrevive reinicios de Render)
    const cacheDocId = `acg_${req.userId}_${otraCartaId || 'propia'}`;
    if (!req.body?.forzar) {
      const { data: cacheDb } = await supabase
        .from('cache_persistente')
        .select('datos')
        .eq('clave', cacheDocId)
        .maybeSingle();
      if (cacheDb?.datos) {
        cacheSet(cacheKey, cacheDb.datos, TTL.ASTROCARTOGRAFIA);
        return res.json(cacheDb.datos);
      }
    }

    let datosSubject;
    if (otraCartaId) {
      const { data: persona, error } = await supabase.from('otras_cartas').select('*').eq('id', otraCartaId).eq('user_id', req.userId).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const [respuesta, analisisLugares] = await Promise.all([
      astrologyApi.post('/astrocartography/map', {
        subject: datosSubject,
        map_options: {
          planets: ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Mean_Node'],
          line_types: ['AC', 'MC', 'DS', 'IC'],
          map_projection: 'mercator',
        },
        visual_options: {
          width: 1000, height: 500, theme: 'modern', show_legend: true,
          city_min_population: 500000, language: 'es',
        },
      }),
      astrologyApi.post('/astrocartography/location-analysis', {
        subject: datosSubject,
        analysis_options: { language: 'es', tradition: 'psychological' },
      }).catch(e => { const detalle = e?.response?.data || e.message; console.error('location-analysis falló:', detalle); return { _error_debug: detalle }; }),
    ]);

    const respuestaACG = {
      svg: respuesta.data?.svg_content || null,
      zonas_poder: respuesta.data?.map_data?.power_zones || [],
      lineas: respuesta.data?.map_data?.lines || [],
      ciudades: respuesta.data?.map_data?.cities_shown || [],
      analisis_personalizado: analisisLugares?.data || null,
      analisis_personalizado_error: analisisLugares?._error_debug || null,
    };
    await traducirInterpretacionesEnObjeto(respuestaACG);

    // Guardar en memoria y en Supabase
    cacheSet(cacheKey, respuestaACG, TTL.ASTROCARTOGRAFIA);
    supabase.from('cache_persistente').upsert({ clave: cacheDocId, datos: respuestaACG, updated_at: new Date().toISOString() }, { onConflict: 'clave' }).then(() => {}).catch(e => console.error('No se pudo guardar caché ACG:', e.message));

    res.json(respuestaACG);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la astrocartografía.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// ============================================================
// RUTA: Iniciar el cobro de la suscripción mensual ($8.88 USD)
// ============================================================
// RUTA: Sinastría (compatibilidad) entre la usuaria y otra persona
// RUTA: Carta compuesta (punto medio entre dos cartas)
// FASE 10 — SOPORTE Y FEEDBACK
app.post('/feedback', requireLogin, async (req, res) => {
  try {
    const { tipo, mensaje } = req.body;
    if (!mensaje?.trim()) return res.status(400).json({ error: 'Escribe tu mensaje.' });
    const perfil = await leerPerfil(req);
    const { error } = await req.supabase.from('feedback').insert({
      user_id: req.userId,
      email: perfil?.email || req.userEmail || null,
      tipo: tipo || 'general',
      mensaje: mensaje.trim(),
    });
    if (error) {
      // Si la tabla no existe aún, respondemos OK igual (no bloquear la app)
      console.error('feedback table:', error.message);
    }
    res.json({ ok: true, mensaje: '¡Gracias! Tu mensaje fue recibido.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo enviar el mensaje.' });
  }
});

// FASE 9 — ASISTENTE IA (usa la carta natal como contexto)
app.post('/asistente-ia', requireLogin, requirePremium, async (req, res) => {
  try {
    const { pregunta, historial } = req.body;
    if (!pregunta?.trim()) return res.status(400).json({ error: 'Falta la pregunta.' });

    const perfil = await leerPerfil(req);
    const { data: cartaData } = await req.supabase
      .from('natal_charts').select('datos_carta').eq('user_id', req.userId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    const sd = cartaData?.datos_carta?.subject_data;
    const cd = cartaData?.datos_carta?.chart_data;

    let contexto = `Eres una astróloga experta y empática. Estás hablando con ${perfil?.nombre || 'la usuaria'}.\n\n`;
    if (sd?.sun) {
      contexto += `Su carta natal:\n- Sol en ${sd.sun.sign} (Casa ${sd.sun.house || '?'})\n- Luna en ${sd.moon?.sign || '?'} (Casa ${sd.moon?.house || '?'})\n- Ascendente en ${sd.ascendant?.sign || '?'}\n- Mercurio en ${sd.mercury?.sign || '?'}, Venus en ${sd.venus?.sign || '?'}, Marte en ${sd.mars?.sign || '?'}\n- Júpiter en ${sd.jupiter?.sign || '?'}, Saturno en ${sd.saturn?.sign || '?'}\n\n`;
    }
    if (cd?.aspects?.length) {
      const aspectosPrincipales = cd.aspects.slice(0, 5).map(a => `${a.point1} ${a.aspect_type} ${a.point2}`).join(', ');
      contexto += `Aspectos principales: ${aspectosPrincipales}\n\n`;
    }
    contexto += `Responde en español, de manera cálida, concreta y personal. Máximo 150 palabras. No inventes posiciones planetarias — solo usa las que te dí.`;

    const mensajes = [
      ...(historial || []),
      { role: 'user', content: pregunta.trim() },
    ];

    const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: contexto, messages: mensajes }),
    });

    const datos = await respuesta.json();
    const texto = datos.content?.[0]?.text || 'No pude generar una respuesta. Intenta de nuevo.';
    res.json({ respuesta: texto });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error en el asistente IA.', detalle: err.message });
  }
});

// ============================================================
// DERECHOS ARCO — Descarga y eliminación de datos del usuario
// ============================================================
app.get('/mis-datos', requireLogin, async (req, res) => {
  try {
    const [perfil, cartas, otras, diario, suscripcion] = await Promise.all([
      req.supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle(),
      req.supabase.from('natal_charts').select('datos_carta, created_at').eq('user_id', req.userId).maybeSingle(),
      req.supabase.from('otras_cartas').select('nombre, fecha_nacimiento, ciudad_nacimiento, created_at').eq('user_id', req.userId),
      req.supabase.from('diario').select('fecha, estado_animo, categorias, texto, luna_signo, dia_personal, created_at').eq('user_id', req.userId).order('created_at', { ascending: false }).limit(100),
      req.supabase.from('subscriptions').select('estado, created_at').eq('user_id', req.userId).maybeSingle(),
    ]);
    res.json({
      exportado_el: new Date().toISOString(),
      perfil: perfil.data,
      carta_natal: cartas.data ? { calculada_el: cartas.data.created_at } : null,
      personas_guardadas: otras.data || [],
      entradas_diario: diario.data || [],
      suscripcion: suscripcion.data,
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron exportar los datos.' });
  }
});

app.delete('/mi-cuenta', requireLogin, async (req, res) => {
  try {
    // Borrar todos los datos del usuario en orden
    await Promise.all([
      req.supabase.from('diario').delete().eq('user_id', req.userId),
      req.supabase.from('natal_charts').delete().eq('user_id', req.userId),
      req.supabase.from('otras_cartas').delete().eq('user_id', req.userId),
      req.supabase.from('subscriptions').delete().eq('user_id', req.userId),
      req.supabase.from('feedback').delete().eq('user_id', req.userId),
    ]);
    await req.supabase.from('profiles').delete().eq('id', req.userId);
    // Eliminar el usuario de auth (requiere service_role key en supabase admin)
    await supabase.auth.admin.deleteUser(req.userId).catch(() => null);
    res.json({ ok: true, mensaje: 'Cuenta y datos eliminados.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo eliminar la cuenta.' });
  }
});

app.post('/carta-compuesta', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const otraCartaId = req.body?.otra_carta_id || null;

    // Caché persistente en Supabase — la carta compuesta no cambia
    if (otraCartaId && !req.body?.forzar) {
      const cacheDocId = `compuesta_${req.userId}_${otraCartaId}`;
      const { data: cacheDb } = await supabase
        .from('cache_persistente')
        .select('datos')
        .eq('clave', cacheDocId)
        .maybeSingle();
      if (cacheDb?.datos) return res.json(cacheDb.datos);
    }

    let datosOtraPersona;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase
        .from('otras_cartas').select('*').eq('id', req.body.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosOtraPersona = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;
      if (!nombre || !fecha_nacimiento) return res.status(400).json({ error: 'Faltan datos.' });
      datosOtraPersona = birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo }, nombre);
    }

    const [compuesta, dinamica, reseñaCompuesta] = await Promise.all([
      astrologyApi.post('/charts/composite', {
        subject1: birthDataDesdePerfil(perfil),
        subject2: datosOtraPersona,
        options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
      }).catch(e => ({ error: e?.response?.data || e.message })),
      astrologyApi.post('/analysis/synastry-transits', {
        subject1: birthDataDesdePerfil(perfil),
        subject2: datosOtraPersona,
        options: { language: 'es' },
      }).catch(e => ({ error: e?.response?.data || e.message })),
      astrologyApi.post('/analysis/composite-report', {
        subject1: birthDataDesdePerfil(perfil),
        subject2: datosOtraPersona,
        report_options: { tradition: 'psychological', language: 'es' },
      }).catch(e => { console.error('composite-report falló:', e?.response?.data || e.message); return null; }),
    ]);

    await Promise.all([
      traducirInterpretacionesEnObjeto(compuesta.data || compuesta),
      traducirInterpretacionesEnObjeto(dinamica.data || dinamica),
      traducirInterpretacionesEnObjeto(reseñaCompuesta?.data),
    ]);

    const respuestaCompuesta = {
      carta_compuesta: compuesta.data || compuesta,
      dinamica_ahora: dinamica.data || dinamica,
      reseña: reseñaCompuesta?.data || null,
    };

    // Guardar en caché persistente si tiene ID de carta guardada
    if (otraCartaId) {
      const cacheDocId = `compuesta_${req.userId}_${otraCartaId}`;
      supabase.from('cache_persistente').upsert({ clave: cacheDocId, datos: respuestaCompuesta, updated_at: new Date().toISOString() }, { onConflict: 'clave' }).then(() => {}).catch(() => {});
    }

    res.json(respuestaCompuesta);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la carta compuesta.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/sinastria', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    let datosOtraPersona;
    let personaGuardada = null;

    if (req.body?.otra_carta_id) {
      // Opción A: usar una carta ya guardada
      const { data: persona, error } = await req.supabase
        .from('otras_cartas')
        .select('*')
        .eq('id', req.body?.otra_carta_id)
        .single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta guardada.' });
      personaGuardada = persona;

      // ¿Ya calculamos esta sinastría antes? Si sí, la regresamos sin gastar créditos
      if (persona.sinastria_cache) {
        return res.json({ reporte: persona.sinastria_cache, desde_cache: true });
      }
      datosOtraPersona = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      // Opción B: datos escritos a mano (no se guarda en caché)
      const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;
      if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
        return res.status(400).json({ error: 'Faltan datos de la otra persona.' });
      }
      datosOtraPersona = birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo }, nombre);
    }

    const respuesta = await astrologyApi.post('/analysis/synastry-report', {
      subject1: birthDataDesdePerfil(perfil),
      subject2: datosOtraPersona,
      options: { house_system: 'P', zodiac_type: 'Tropic' },
      report_options: { tradition: 'psychological', language: 'es' },
    });

    // Buscamos y traducimos CUALQUIER campo "interpretation" en toda la respuesta,
    // sin importar en qué nivel de anidación esté (la ruta exacta puede variar)
    const objetosConInterpretacion = [];
    function buscarInterpretaciones(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.interpretation === 'string' && obj.interpretation.trim()) objetosConInterpretacion.push(obj);
      for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') buscarInterpretaciones(obj[key]);
      }
    }
    buscarInterpretaciones(respuesta.data);
    if (objetosConInterpretacion.length) {
      const { textos: traducidos } = await traducirTextosConIA(objetosConInterpretacion.map(o => o.interpretation));
      objetosConInterpretacion.forEach((o, i) => { if (traducidos[i]) o.interpretation = traducidos[i]; });
    }

    if (personaGuardada) {
      await req.supabase.from('otras_cartas').update({ sinastria_cache: respuesta.data }).eq('id', personaGuardada.id);
    }

    res.json({ reporte: respuesta.data, desde_cache: false, debug_interpretaciones_traducidas: objetosConInterpretacion.length });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la sinastría.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Flor armónica (harmonic chart)
// RUTA: Horóscopo diario personalizado (real)
// RUTA: Ver el detalle completo de una carta guardada
app.get('/otras-cartas/:id', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('otras_cartas')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ carta: data });
});

// RUTA: Eliminar una carta de otra persona (se usa también para "editar": borrar y volver a calcular)
app.delete('/otras-cartas/:id', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('otras_cartas')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data || data.length === 0) {
    return res.status(404).json({ error: `No se encontró ninguna carta con ese ID para borrar (id enviado: ${req.params.id}).` });
  }
  res.json({ mensaje: 'Carta eliminada', borrada: data[0] });
});

// RUTA: Resumen de personalidad de una carta guardada (otra persona)
app.post('/otras-cartas/:id/resumen', requireLogin, async (req, res) => {
  try {
    const { data: persona, error } = await req.supabase
      .from('otras_cartas')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });

    if (persona.resumen_cache) {
      return res.json({ reporte: persona.resumen_cache, desde_cache: true });
    }

    const respuesta = await astrologyApi.post('/analysis/natal-report', {
      subject: birthDataDesdePerfil(persona, persona.nombre),
      report_options: { tradition: 'psychological', language: 'es' },
    });

    await req.supabase.from('otras_cartas').update({ resumen_cache: respuesta.data }).eq('id', persona.id);

    res.json({ reporte: respuesta.data, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el resumen.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Generar la carta visual (rueda) de una persona guardada
app.post('/otras-cartas/:id/visual', requireLogin, async (req, res) => {
  try {
    const { data: persona, error } = await req.supabase
      .from('otras_cartas')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });

    if (persona.svg_visual) {
      return res.json({ svg: persona.svg_visual, desde_cache: true });
    }

    const respuesta = await astrologyApi.post('/render/natal', {
      subject: birthDataDesdePerfil(persona, persona.nombre),
      options: { house_system: 'P' },
      render_options: { format: 'svg', theme: 'light' },
    });

    let svg = null;
    const crudoTexto = typeof respuesta.data === 'string' ? respuesta.data : JSON.stringify(respuesta.data);
    const inicioSvg = crudoTexto.indexOf('<svg');
    if (inicioSvg !== -1) svg = crudoTexto.slice(inicioSvg);
    else if (respuesta.data?.svg_content) svg = respuesta.data.svg_content;

    if (svg) await req.supabase.from('otras_cartas').update({ svg_visual: svg }).eq('id', persona.id);

    res.json({ svg, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Guardar y calcular la carta de otra persona (familia, pareja, amigas — hasta 8)
app.post('/otras-cartas', requireLogin, async (req, res) => {
  try {
    const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud } = req.body;
    if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
      return res.status(400).json({ error: 'Faltan datos de la persona.' });
    }

    const { count } = await req.supabase.from('otras_cartas').select('*', { count: 'exact', head: true });
    if (count >= 8) return res.status(400).json({ error: 'Ya tienes 8 cartas guardadas (el máximo).' });

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud }, nombre),
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const registroAGuardar = {
      user_id: req.userId, nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo,
      datos_carta: respuesta.data,
    };
    if (typeof latitud === 'number' && !isNaN(latitud)) registroAGuardar.latitud = latitud;
    if (typeof longitud === 'number' && !isNaN(longitud)) registroAGuardar.longitud = longitud;

    const { data, error } = await req.supabase
      .from('otras_cartas')
      .insert(registroAGuardar)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ mensaje: 'Carta guardada', carta: data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular/guardar la carta.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Editar una carta ya existente — ACTUALIZA en el mismo lugar (no crea una nueva)
app.put('/otras-cartas/:id', requireLogin, async (req, res) => {
  try {
    const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud } = req.body;
    if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
      return res.status(400).json({ error: 'Faltan datos de la persona.' });
    }

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud }, nombre),
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const registroActualizado = {
      nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo,
      datos_carta: respuesta.data,
      latitud: (typeof latitud === 'number' && !isNaN(latitud)) ? latitud : null,
      longitud: (typeof longitud === 'number' && !isNaN(longitud)) ? longitud : null,
      sinastria_cache: null,
      resumen_cache: null,
      svg_visual: null,
    };

    // Borrar caché de carta compuesta en cache_persistente
    supabase.from('cache_persistente')
      .delete()
      .eq('clave', `compuesta_${req.userId}_${req.params.id}`)
      .then(() => {}).catch(() => {});

    const { data, error } = await req.supabase
      .from('otras_cartas')
      .update(registroActualizado)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'No se encontró esa carta.' });
    res.json({ mensaje: 'Carta actualizada', carta: data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo actualizar la carta.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Listar las cartas de otras personas ya guardadas
app.get('/otras-cartas', requireLogin, async (req, res) => {
  // Usamos el cliente ADMIN (service_role) con filtro explícito por user_id
  // para evitar que RLS bloquee silenciosamente las cartas guardadas.
  // El frontend mostraba "sin cartas" aunque sí existían — era un bug de RLS.
  const { data, error } = await supabase
    .from('otras_cartas')
    .select('id, nombre, fecha_nacimiento, ciudad_nacimiento, created_at')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ cartas: data || [] });
});

// RUTA: Próximos eclipses y cómo afectan tu carta natal
app.post('/eclipses-natal', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date().toISOString().slice(0, 10);
    const cacheKey = cacheHash(req.userId, 'eclipses', hoyStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [proximos, revision] = await Promise.all([
      astrologyApi.get('/eclipses/upcoming').catch(err => ({ error: err?.response?.data || err.message })),
      astrologyApi.post('/eclipses/natal-check', {
        subject: birthDataDesdePerfil(perfil),
      }).catch(err => ({ error: err?.response?.data || err.message })),
    ]);

    // Interpretación completa (ventanas de tiempo + consejos) del eclipse más importante
    let interpretacionCompleta = null;
    const idPrincipal = revision.data?.data?.next_important_eclipse?.eclipse_id;
    if (idPrincipal) {
      try {
        const r = await astrologyApi.post('/eclipses/interpretation', { eclipse_id: idPrincipal, language: 'es' });
        interpretacionCompleta = r.data;

        // Traducir de verdad las ventanas de tiempo y consejos (vienen en inglés aunque pidamos language:'es')
        const interp = interpretacionCompleta?.data?.interpretation || interpretacionCompleta?.interpretation;
        if (interp) {
          const tv = interp.timing_windows || {};
          const textosATraducir = [tv.pre_eclipse || '', tv.eclipse_day || '', tv.post_eclipse || '', ...(interp.advice || [])];
          const { textos: traducidos } = await traducirTextosConIA(textosATraducir);
          if (tv.pre_eclipse) tv.pre_eclipse = traducidos[0] || tv.pre_eclipse;
          if (tv.eclipse_day) tv.eclipse_day = traducidos[1] || tv.eclipse_day;
          if (tv.post_eclipse) tv.post_eclipse = traducidos[2] || tv.post_eclipse;
          if (interp.advice?.length) interp.advice = interp.advice.map((a, i) => traducidos[3 + i] || a);
        }
      } catch (e) { /* si falla, seguimos sin ella */ }
    }

    const respuestaEclipses = {
      proximos_eclipses: proximos.data || proximos,
      como_te_afecta: revision.data || revision,
      interpretacion_principal: interpretacionCompleta,
    };
    cacheSet(cacheKey, respuestaEclipses, TTL.ECLIPSES);
    res.json(respuestaEclipses);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo consultar eclipses.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Calendario lunar del mes — mejores días específicos por actividad
app.post('/calendario-lunar', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const hoy = new Date();
    const anio = parseInt(req.body?.anio) || hoy.getUTCFullYear();
    const mes = parseInt(req.body?.mes) || (hoy.getUTCMonth() + 1);
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

    // Caché por usuario + mes/año — este cálculo cuesta ~32 créditos de API, no debe repetirse en cada clic.
    // forzar_recalculo permite saltarse el caché (para pruebas, sin afectar el comportamiento normal).
    const cacheKey = cacheHash(req.userId, 'calendario-lunar', `${anio}-${mes}`);
    const cached = cacheGet(cacheKey);
    if (cached && !req.body?.forzar_recalculo) return res.json(cached);

    const dias = Array.from({ length: diasEnMes }, (_, i) => i + 1);

    // OPTIMIZACIÓN (30 sept): Una sola llamada para TODO el mes, en lugar de 30+ llamadas
    const obtenerResultados = async () => {
      try {
        const r = await astrologyApi.post('/lunar/month-report', {
          datetime_location: {
            year: anio, month: mes, day: 1, hour: 0, minute: 0, second: 0,
            city: perfil?.ciudad_nacimiento || 'Mexico City', country_code: perfil?.pais_codigo || 'MX',
          },
          language: 'es',
        }).catch(() => null);
        
        // Si el endpoint de mes no existe, fallback: una sola llamada al análisis lunar y extrapolar
        if (!r?.data) {
          const rLuna = await astrologyApi.post('/analysis/lunar-analysis', {
            datetime_location: {
              year: anio, month: mes, day: 15, hour: 12, minute: 0, second: 0,
              city: perfil?.ciudad_nacimiento || 'Mexico City', country_code: perfil?.pais_codigo || 'MX',
            },
            report_options: { language: 'es' },
          }).catch(() => ({ data: null }));
          const m = rLuna.data?.data?.lunar_metrics;
          // Fallback simple: usar datos del medio del mes para todos los días
          return dias.map(dia => ({
            dia, 
            signo: m?.moon_sign || null, 
            fase: dia <= 15 ? 'Waxing Crescent' : 'Waning Gibbous' // aproximado
          }));
        }
        
        // Si existe month-report, parsear respuesta
        return (r.data?.data?.days || r.data?.days || []).map(d => ({
          dia: d.day || d.date?.day,
          signo: d.moon_sign || d.lunar_data?.moon_sign,
          fase: faseCoherente(d.moon_phase, d.moon_illumination)
        }));
      } catch (e) {
        console.error('obtenerResultados falló:', e.message);
        return dias.map(dia => ({ dia, signo: null, fase: null }));
      }
    };

    const [resultados, chartHoy, transitosMes] = await Promise.all([
      obtenerResultados(),
      astrologyApi.post('/charts/natal', {
        subject: { name: 'Hoy', birth_data: { year: anio, month: mes, day: hoy.getUTCDate(), hour: 12, minute: 0, second: 0, city: perfil?.ciudad_nacimiento || 'Mexico City', country_code: perfil?.pais_codigo || 'MX' } },
        options: { house_system: 'P', zodiac_type: 'Tropic' },
      }).catch(() => null),
      // ---- Días de poder PERSONALES: cruzamos el mes completo contra la carta natal real ----
      perfil ? astrologyApi.post('/analysis/natal-transit-report', {
        subject: birthDataDesdePerfil(perfil),
        transit_time: {
          date_range: {
            start_date: { year: anio, month: mes, day: 1 },
            end_date: { year: anio, month: mes, day: diasEnMes },
          },
        },
        orb: 2,
        report_options: { tradition: 'psychological', language: 'es' },
      }).catch(e => { console.error('natal-transit-report (calendario) falló:', e?.response?.data || e.message); return { _error_debug: e?.response?.data || e.message }; }) : Promise.resolve(null),
    ]);

    const mercurioRetrogrado = chartHoy?.data?.subject_data?.mercury?.retrograde || false;

    const creciente = f => f && f.includes('Waxing');
    const menguante = f => f && f.includes('Waning');
    const nueva = f => f === 'New Moon';

    const calendario = {
      cortarte_el_cabello: resultados.filter(d => creciente(d.fase) && ['Tau', 'Leo'].includes(d.signo)).map(d => d.dia),
      tatuarte: resultados.filter(d => menguante(d.fase) && d.signo !== 'Sco').map(d => d.dia),
      lanzar_negocio: resultados.filter(d => nueva(d.fase) || (creciente(d.fase) && d.dia <= 10)).map(d => d.dia),
      pedir_credito: resultados.filter(d => creciente(d.fase) && ['Tau', 'Cap'].includes(d.signo)).map(d => d.dia),
      cirugias: resultados.filter(d => menguante(d.fase) && d.signo !== 'Sco').map(d => d.dia),
      firmar_contrato: resultados.filter(d => creciente(d.fase) && ['Vir', 'Lib', 'Cap'].includes(d.signo)).map(d => d.dia),
      entrevista_trabajo: resultados.filter(d => creciente(d.fase) && ['Leo', 'Cap', 'Sag'].includes(d.signo)).map(d => d.dia),
    };

    // ---- Procesar días de poder personal ----
    const PLANETAS_BENEFICOS = ['Sun', 'Venus', 'Jupiter'];
    const NOMBRE_ES = {
      Sun: 'Sol', Moon: 'Luna', Mercury: 'Mercurio', Venus: 'Venus', Mars: 'Marte',
      Jupiter: 'Júpiter', Saturn: 'Saturno', Uranus: 'Urano', Neptune: 'Neptuno', Pluto: 'Plutón',
      Medium_Coeli: 'Medio Cielo', Midheaven: 'Medio Cielo', MC: 'Medio Cielo',
      Ascendant: 'Ascendente', Descendant: 'Descendente', Imum_Coeli: 'Fondo de Cielo',
      Mean_Node: 'Nodo Norte', True_Node: 'Nodo Norte', North_Node: 'Nodo Norte',
      Mean_South_Node: 'Nodo Sur', True_South_Node: 'Nodo Sur', South_Node: 'Nodo Sur',
      Mean_Lilith: 'Lilith', True_Lilith: 'Lilith', Lilith: 'Lilith', Black_Moon_Lilith: 'Lilith',
      Chiron: 'Quirón',
    };
    const ASPECTO_ES = { trine: 'trígono', sextile: 'sextil', conjunction: 'conjunción', square: 'cuadratura', opposition: 'oposición' };
    const BUENO_PARA = {
      Sun: 'destacar, liderar, mostrarte y ganar visibilidad',
      Moon: 'tu bienestar emocional, el hogar y la familia',
      Mercury: 'comunicar, firmar, negociar y cerrar acuerdos',
      Venus: 'el amor, la belleza, el dinero y las relaciones',
      Mars: 'tomar acción, arrancar proyectos y tener energía extra',
      Jupiter: 'crecer, expandirte, tener suerte y oportunidades',
      Saturn: 'compromisos serios, estructura y responsabilidad',
      Medium_Coeli: 'tu carrera, tu imagen pública y lanzamientos',
      Midheaven: 'tu carrera, tu imagen pública y lanzamientos',
      MC: 'tu carrera, tu imagen pública y lanzamientos',
      Ascendant: 'tu imagen personal y las primeras impresiones',
      Descendant: 'sociedades, pareja y acuerdos con otros',
      Imum_Coeli: 'tu casa, tus raíces y tu vida privada',
    };
    const ASPECTOS_FAVORABLES = ['trine', 'sextile', 'conjunction'];
    const PUNTOS_EXITO = ['Sun', 'Venus', 'Jupiter', 'Medium_Coeli', 'Midheaven', 'MC', 'Ascendant'];
    let diasPoderPersonal = {};
    let diasPoderError = null;
    let diasPoderDiagnostico = null;
    const eventosMes = transitosMes?.data?.data?.events || transitosMes?.data?.events || null;
    if (transitosMes?._error_debug) {
      diasPoderError = transitosMes._error_debug;
    } else if (Array.isArray(eventosMes)) {
      eventosMes.forEach(ev => {
        const aspecto = (ev.aspect_type || '').toLowerCase();
        const favorable = ASPECTOS_FAVORABLES.includes(aspecto)
          && PLANETAS_BENEFICOS.includes(ev.transiting_planet)
          && PUNTOS_EXITO.includes(ev.stationed_planet);
        if (!favorable) return;
        const fechaCruda = ev.date || ev.exact_date || ev.timestamp || ev.start_date || ev.datetime;
        if (!fechaCruda) return;
        let diaNum = null;
        if (typeof fechaCruda === 'object' && fechaCruda.day) diaNum = fechaCruda.day;
        else { const d = new Date(fechaCruda); if (!isNaN(d)) diaNum = d.getUTCDate(); }
        if (!diaNum) return;
        diasPoderPersonal[diaNum] = diasPoderPersonal[diaNum] || [];
        const buenoPara = BUENO_PARA[ev.stationed_planet];
        const mensaje = `${NOMBRE_ES[ev.transiting_planet] || ev.transiting_planet} en ${ASPECTO_ES[aspecto] || aspecto} con tu ${NOMBRE_ES[ev.stationed_planet] || ev.stationed_planet} natal` + (buenoPara ? ` — bueno para ${buenoPara}` : '');
        diasPoderPersonal[diaNum].push(mensaje);
      });
      // Diagnóstico temporal: si no encontramos ningún día, mostrar por qué (cuántos eventos había y cómo se ven)
      if (Object.keys(diasPoderPersonal).length === 0) {
        diasPoderDiagnostico = {
          total_eventos_recibidos: eventosMes.length,
          ejemplo_primer_evento: eventosMes[0] || null,
          ejemplo_ultimo_evento: eventosMes[eventosMes.length - 1] || null,
        };
      }
    } else if (perfil) {
      diasPoderError = 'La respuesta no tuvo el campo "events" esperado. Estructura recibida: ' + JSON.stringify(Object.keys(transitosMes?.data || {}));
    }

    // ============================================================
    // "TU MES ASTROLÓGICO" — reutiliza eventosMes y resultados (ya obtenidos arriba,
    // sin llamadas nuevas a la API) para armar: eventos destacados, lunaciones,
    // retrógrados, áreas de vida más activas, y un relato narrativo con IA basado
    // ÚNICAMENTE en los datos reales calculados (nunca inventa fechas/signos/aspectos).
    // ============================================================
    const AREA_POR_CASA = {
      1: 'tu identidad y cómo te muestras al mundo', 2: 'dinero y recursos materiales',
      3: 'comunicación, aprendizaje y el entorno cercano', 4: 'hogar, familia y raíces',
      5: 'creatividad, romance y disfrute', 6: 'trabajo diario y salud',
      7: 'relaciones y sociedades', 8: 'transformación, intimidad y recursos compartidos',
      9: 'crecimiento, viajes y visión de vida', 10: 'carrera e imagen pública',
      11: 'comunidad, amistades y proyectos a futuro', 12: 'descanso, espiritualidad y lo oculto',
    };
    let eventosDestacadosMes = [];
    let lunacionesMes = { luna_nueva: [], luna_llena: [] };
    let retrogradosMes = [];
    let areasMes = [];
    let relatoMes = null;
    // Ingresos de signo (Venus entra a Escorpio, etc.) — calculados con efemérides propias
    // (matemática astronómica real, día por día), cubriendo TODO el mes, pasado y futuro,
    // sin depender de la API externa ni gastar créditos extra.
    let ingresosMes = [];
    try {
      ingresosMes = ingresosDelMesPorEfemerides(anio, mes, diasEnMes);
    } catch (e) {
      console.error('No se pudieron calcular ingresos del mes con efemérides:', e.message);
    }

    if (Array.isArray(eventosMes)) {
      // Eventos mayores: aspectos exactos (orbe pequeño) a puntos natales importantes.
      // Un mismo aspecto (ej. Sol sextil tu Plutón) puede seguir "exacto" varios días seguidos —
      // aquí lo agrupamos por el aspecto en sí (sin la fecha) y nos quedamos SOLO con el día
      // de orbe más pequeño (el más exacto), para no repetir el mismo evento 20 veces.
      const mejorPorAspecto = new Map();
      eventosMes.forEach(ev => {
        const orbeAbs = Math.abs(ev.orb ?? 99);
        if (orbeAbs > 1.5) return; // solo lo más exacto/significativo del mes
        const fechaCruda = ev.date || ev.exact_date || ev.timestamp || ev.start_date || ev.datetime;
        let fechaISO = null;
        if (typeof fechaCruda === 'object' && fechaCruda.day) fechaISO = `${fechaCruda.year}-${String(fechaCruda.month).padStart(2,'0')}-${String(fechaCruda.day).padStart(2,'0')}`;
        else { const d = new Date(fechaCruda); if (!isNaN(d)) fechaISO = d.toISOString().slice(0, 10); }
        if (!fechaISO) return;
        const clave = `${ev.transiting_planet}|${ev.aspect_type}|${ev.stationed_planet}`;
        const existente = mejorPorAspecto.get(clave);
        if (!existente || orbeAbs < existente.orbeAbs) {
          mejorPorAspecto.set(clave, { ev, fechaISO, orbeAbs });
        }
      });
      const PUNTOS_NATALES_CLAVE = ['Sun', 'Moon', 'Ascendant', 'Medium_Coeli', 'Midheaven', 'MC'];
      mejorPorAspecto.forEach(({ ev, fechaISO }) => {
        eventosDestacadosMes.push({
          fecha: fechaISO,
          planeta_transito: NOMBRE_ES[ev.transiting_planet] || ev.transiting_planet,
          aspecto: ASPECTO_ES[(ev.aspect_type || '').toLowerCase()] || ev.aspect_type,
          punto_natal: NOMBRE_ES[ev.stationed_planet] || ev.stationed_planet,
          casa_natal: ev.natal_house || null,
          area: ev.natal_house ? AREA_POR_CASA[ev.natal_house] : null,
          clave_para_puntos: PUNTOS_NATALES_CLAVE.includes(ev.stationed_planet),
        });
      });
      eventosDestacadosMes.sort((a, b) => a.fecha.localeCompare(b.fecha));

      // Retrógrados/directos: detecta cambio de signo de velocidad por planeta a lo largo del mes
      const velocidadPorPlaneta = {};
      eventosMes.forEach(ev => {
        if (typeof ev.transiting_speed !== 'number' || !ev.transiting_planet) return;
        const fechaCruda = ev.date || ev.exact_date;
        const d = new Date(typeof fechaCruda === 'object' ? `${fechaCruda.year}-${fechaCruda.month}-${fechaCruda.day}` : fechaCruda);
        if (isNaN(d)) return;
        const key = ev.transiting_planet;
        velocidadPorPlaneta[key] = velocidadPorPlaneta[key] || [];
        velocidadPorPlaneta[key].push({ fecha: d.toISOString().slice(0, 10), speed: ev.transiting_speed });
      });
      Object.entries(velocidadPorPlaneta).forEach(([planeta, puntos]) => {
        puntos.sort((a, b) => a.fecha.localeCompare(b.fecha));
        for (let i = 1; i < puntos.length; i++) {
          const antes = puntos[i - 1].speed, ahora = puntos[i].speed;
          if (antes > 0 && ahora < 0) retrogradosMes.push({ planeta: NOMBRE_ES[planeta] || planeta, fecha: puntos[i].fecha, tipo: 'se_vuelve_retrogrado' });
          if (antes < 0 && ahora > 0) retrogradosMes.push({ planeta: NOMBRE_ES[planeta] || planeta, fecha: puntos[i].fecha, tipo: 'vuelve_directo' });
        }
      });
      // Dedupe simple (evita marcar el mismo día repetido por múltiples eventos del mismo planeta)
      retrogradosMes = retrogradosMes.filter((r, i, arr) => arr.findIndex(x => x.planeta === r.planeta && x.tipo === r.tipo) === i);
      // Duración típica aproximada por planeta (conocimiento astrológico general, no una fecha específica inventada)
      const DURACION_TIPICA_RETRO = {
        Mercury: 'unas 3 semanas', Venus: 'unas 6 semanas', Mars: 'unos 2 a 2.5 meses',
        Jupiter: 'unos 4 meses', Saturn: 'unos 4.5 meses', Uranus: 'unos 5 meses',
        Neptune: 'unos 5 meses', Pluto: 'unos 5 meses',
      };
      retrogradosMes.forEach(r => {
        const claveOriginal = Object.keys(NOMBRE_ES).find(k => NOMBRE_ES[k] === r.planeta);
        r.duracion_tipica = DURACION_TIPICA_RETRO[claveOriginal] || null;
      });

      // Áreas de vida más activas del mes (top 3, solo si hay datos — nunca todas por obligación)
      const conteoAreas = {};
      eventosDestacadosMes.forEach(e => { if (e.area) conteoAreas[e.area] = (conteoAreas[e.area] || 0) + 1; });
      areasMes = Object.entries(conteoAreas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([area]) => area);
    }

    // Lunaciones del mes (luna nueva / luna llena) con su signo real, tomadas del detalle día a día ya calculado
    lunacionesMes = { luna_nueva: [], luna_llena: [] };
    resultados.forEach(d => {
      const signoEs = d.signo ? (SIGNOS_ES_INGRESO[d.signo] || d.signo) : null;
      if (d.fase === 'New Moon') lunacionesMes.luna_nueva.push({ dia: d.dia, signo: signoEs });
      if (d.fase === 'Full Moon') lunacionesMes.luna_llena.push({ dia: d.dia, signo: signoEs });
    });

    // Relato del mes con IA — SOLO redacta con los hechos reales de arriba, nunca inventa datos.
    // Se guarda en caché junto con el resto (una vez por usuaria por mes).
    const hayAlgoQueContar = eventosDestacadosMes.length || lunacionesMes.luna_nueva.length || lunacionesMes.luna_llena.length || retrogradosMes.length || ingresosMes.length;
    if (process.env.ANTHROPIC_API_KEY && hayAlgoQueContar) {
      try {
        const hechos = [
          ...eventosDestacadosMes.slice(0, 10).map(e => `Día ${e.fecha.slice(-2)}: ${e.planeta_transito} en ${e.aspecto} con tu ${e.punto_natal} natal${e.area ? ` (afecta ${e.area})` : ''}.`),
          ...lunacionesMes.luna_nueva.map(l => `Día ${l.dia}: Luna Nueva${l.signo ? ` en ${l.signo}` : ''}.`),
          ...lunacionesMes.luna_llena.map(l => `Día ${l.dia}: Luna Llena${l.signo ? ` en ${l.signo}` : ''}.`),
          ...retrogradosMes.map(r => `Día ${r.fecha.slice(-2)}: ${r.planeta} ${r.tipo === 'se_vuelve_retrogrado' ? 'se vuelve retrógrado' : 'retoma movimiento directo'}.`),
          ...ingresosMes.slice(0, 8).map(i => `Día ${i.fecha.slice(-2)}: ${i.planeta} entró a ${i.signo_nuevo}.`),
        ].join('\n');

        const prompt = `Eres una astróloga profesional escribiendo el relato del mes de ${NOMBRES_MES_LARGO[mes-1] || mes} para alguien SIN conocimientos de astrología, en español de México/Latinoamérica.

Tono: cálido, sencillo, como si le contaras a una amiga qué esperar del mes — NUNCA técnico, NUNCA una lista de fechas leída en voz alta, y NUNCA frases vacías tipo "confía en el universo" o "se vienen cambios".

Estos son los ÚNICOS hechos astrológicos reales de este mes que puedes usar (no inventes fechas, signos, aspectos ni eventos que no estén aquí). No tienes que mencionarlos todos — elige los 3 o 4 más relevantes para el relato y deja el resto fuera, así el texto no se siente como una lista:

${hechos}

Escribe un relato narrativo de 3 párrafos cortos siguiendo esta estructura:
1. "El mes comienza con..." (primeros 10 días)
2. "A mitad de mes..." (días 11-20)
3. "Hacia el final del mes..." (días 21 en adelante)

Si algún tercio del mes no tiene eventos relevantes, dilo brevemente como un tramo más tranquilo, sin inventar nada. Máximo 160 palabras en total. Responde SOLO con el texto del relato, sin título ni markdown, sin tecnicismos como "orbe" o "natal_house".`;

        const controlador = new AbortController();
        const timeoutId = setTimeout(() => controlador.abort(), 30000);
        const respuestaIA = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
          signal: controlador.signal,
        });
        clearTimeout(timeoutId);
        const datosIA = await respuestaIA.json();
        if (respuestaIA.ok) relatoMes = (datosIA.content?.[0]?.text || '').trim();
      } catch (e) {
        console.error('relato_mes falló:', e.message);
      }
    }

    const respuestaCalendario = {
      mes, anio, calendario, detalle_dias: resultados, mercurio_retrogrado: mercurioRetrogrado,
      dias_poder_personal: diasPoderPersonal,
      dias_poder_personal_error: diasPoderError,
      dias_poder_personal_diagnostico: diasPoderDiagnostico,
      // Campos nuevos de "Tu mes astrológico" (puntos 14-17) — no afectan nada de lo anterior
      mes_astrologico: {
        eventos_destacados: eventosDestacadosMes,
        lunaciones: lunacionesMes,
        retrogrados: retrogradosMes,
        ingresos: ingresosMes,
        areas_destacadas: areasMes,
        relato: relatoMes,
      },
    };
    cacheSet(cacheKey, respuestaCalendario, TTL.CALENDARIO_LUNAR);
    res.json(respuestaCalendario);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular el calendario lunar.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Relocación — cómo cambia tu carta si vives en otro lugar
app.post('/relocacion', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const { ciudad, pais_codigo } = req.body;
    if (!ciudad || !pais_codigo) return res.status(400).json({ error: 'Falta la ciudad donde vives ahora.' });

    const respuesta = await astrologyApi.post('/analysis/relocation', {
      subject: birthDataDesdePerfil(perfil),
      options: {
        target_location: { city: ciudad, country_code: pais_codigo },
      },
    });

    const factores = respuesta.data?.data?.key_factors || [];
    const { textos: traducidos, debug: traduccionDebug } = await traducirTextosConIA(factores.map(f => f.interpretation || f.factor || ''));
    factores.forEach((f, i) => { if (traducidos[i]) f.interpretation = traducidos[i]; });

    res.json({ relocacion: respuesta.data, traduccion_debug: traduccionDebug });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la relocación.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Numerología (números núcleo: camino de vida, destino, etc.)
app.post('/numerologia', requireLogin, async (req, res) => {
  try {
    const otraCartaId = req.body?.otra_carta_id || null;
    const cacheKey = cacheHash(req.userId, 'numerologia', otraCartaId || 'propia', hoyStr());

    // 1) Caché en memoria
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // 2) Caché persistente en Supabase — la numerología de números núcleo no cambia
    // (solo el día personal cambia diario, pero los números de camino de vida, destino, etc. son fijos)
    const cacheDocId = `num_${req.userId}_${otraCartaId || 'propia'}`;
    if (!req.body?.forzar) {
      const { data: cacheDb } = await supabase
        .from('cache_persistente')
        .select('datos, updated_at')
        .eq('clave', cacheDocId)
        .maybeSingle();
      // Solo usar caché si fue calculado hoy (el día personal cambia cada día)
      if (cacheDb?.datos && cacheDb.updated_at?.slice(0, 10) === hoyStr()) {
        cacheSet(cacheKey, cacheDb.datos, TTL.NUMEROLOGIA);
        return res.json(cacheDb.datos);
      }
    }

    let datosSubject;
    if (otraCartaId) {
      const { data: persona, error } = await supabase.from('otras_cartas').select('*').eq('id', otraCartaId).eq('user_id', req.userId).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const respuesta = await astrologyApi.post('/numerology/core-numbers', {
      subject: datosSubject,
      language: 'es',
    });

    await traducirInterpretacionesEnObjeto(respuesta.data);
    const r = { numerologia: respuesta.data };

    // Guardar en memoria y Supabase
    cacheSet(cacheKey, r, TTL.NUMEROLOGIA);
    supabase.from('cache_persistente').upsert({ clave: cacheDocId, datos: r, updated_at: new Date().toISOString() }, { onConflict: 'clave' }).then(() => {}).catch(e => console.error('No se pudo guardar caché numerología:', e.message));

    res.json(r);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la numerología.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Estrellas fijas — cuáles tocan tu carta (propia o guardada)
app.post('/estrellas-fijas', requireLogin, async (req, res) => {
  try {
    const otraCartaId = req.body?.otra_carta_id || null;
    const cacheKey = cacheHash(req.userId, 'estrellas', otraCartaId || 'propia');
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    let datosSubject;
    if (otraCartaId) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', otraCartaId).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const respuesta = await astrologyApi.post('/fixed-stars/report', {
      subject: datosSubject,
      language: 'es',
      report_options: { tradition: 'psychological', language: 'es' },
    });

    // Traducir de verdad las interpretaciones y nombres tradicionales (en inglés en la respuesta cruda)
    const contactos = [...(respuesta.data?.data?.conjunctions || []), ...(respuesta.data?.data?.oppositions || [])];
    const textosATraducir = [];
    contactos.forEach(c => {
      textosATraducir.push(c.interpretation || '');
      textosATraducir.push(c.star_data?.traditional_name || '');
    });
    const { textos: traducidos, debug: traduccionDebug } = await traducirTextosConIA(textosATraducir);
    contactos.forEach((c, i) => {
      if (traducidos[i * 2]) c.interpretation = traducidos[i * 2];
      if (traducidos[i * 2 + 1] && c.star_data) c.star_data.traditional_name = traducidos[i * 2 + 1];
    });

    const r = { estrellas: respuesta.data, traduccion_debug: traduccionDebug };
    cacheSet(cacheKey, r, TTL.ESTRELLAS);
    res.json(r);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudieron calcular las estrellas fijas.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Mi energía del día (numerología del día + luna combinadas)
app.post('/energia-del-dia', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date();
    const cacheKey = cacheHash(req.userId, 'energia', hoyStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [ciclos, luna] = await Promise.all([
      astrologyApi.post('/numerology/personal-cycles', {
        subject: birthDataDesdePerfil(perfil),
        target_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1, day: hoy.getUTCDate() },
        language: 'es',
        include: ['personal_day', 'personal_month', 'personal_year'],
      }).catch(err => ({ error: err?.response?.data || err.message })),
      astrologyApi.post('/analysis/lunar-analysis', {
        datetime_location: {
          year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1, day: hoy.getUTCDate(),
          hour: hoy.getUTCHours(), minute: hoy.getUTCMinutes(), second: 0,
          city: perfil.ciudad_nacimiento || 'Mexico City', country_code: perfil.pais_codigo || 'MX',
        },
        report_options: { language: 'es' },
      }).catch(err => ({ error: err?.response?.data || err.message })),
    ]);

    const respuestaEnergia = { ciclos: ciclos.data || ciclos, luna: luna.data || luna };
    
    // OPTIMIZACIÓN (30 sept): Solo traducir si hay texto narrativo (interpretaciones)
    // Los números de ciclos y fases lunares NO necesitan traducción
    if (respuestaEnergia?.luna?.data?.interpretations) {
      const solo_interpretaciones = { interpretations: respuestaEnergia.luna.data.interpretations };
      await traducirInterpretacionesEnObjeto(solo_interpretaciones);
      respuestaEnergia.luna.data.interpretations = solo_interpretaciones.interpretations;
    }
    
    cacheSet(cacheKey, respuestaEnergia, TTL.ENERGIA_DIA);
    res.json(respuestaEnergia);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular tu energía del día.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/horoscopo-diario', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date().toISOString().slice(0, 10);
    const cacheKey = cacheHash(req.userId, 'horoscopo', hoyStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const respuesta = await astrologyApi.post('/horoscope/personal/daily/text', {
      subject: birthDataDesdePerfil(perfil),
      options: { language: 'es' },
    });

    const respuestaHoroscopo = { horoscopo: respuesta.data };
    await traducirInterpretacionesEnObjeto(respuestaHoroscopo);
    cacheSet(cacheKey, respuestaHoroscopo, TTL.HOROSCOPO);
    res.json(respuestaHoroscopo);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el horóscopo.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/flor-armonica', requireLogin, async (req, res) => {
  try {
    let datosSubject;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', req.body?.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const numeroArmonico = req.body?.numero || 5;
    const respuesta = await astrologyApi.post('/charts/harmonic', {
      subject: datosSubject,
      n: numeroArmonico,
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    await traducirInterpretacionesEnObjeto(respuesta.data);
    res.json({ flor: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la flor armónica.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Tránsitos personalizados (próximos 7 días, ventana móvil) — BUG CORREGIDO
app.post('/transitos-personales', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date();
    const hoyStr = hoy.toISOString().slice(0, 10);
    
    // OPTIMIZACIÓN (30 sept): Ventana móvil de 7 días guardada en Supabase
    // En lugar de calcular 12 días completos cada hora, calculamos solo el día nuevo
    const { data: transitoGuardado } = await req.supabase
      .from('transitos_cache')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    let respuesta;
    
    // Si tenemos tránsitos guardados y es el mismo día → devolver sin API call
    if (transitoGuardado?.fecha_hoy === hoyStr && !req.body?.forzar) {
      respuesta = { data: transitoGuardado.datos_transitos };
    } else {
      // Es un día nuevo → calcular solo los 7 próximos días (ventana móvil)
      const en7dias = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      respuesta = await astrologyApi.post('/analysis/natal-transit-report', {
        subject: birthDataDesdePerfil(perfil),
        transit_time: {
          date_range: {
            start_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1, day: hoy.getUTCDate() },
            end_date: { year: en7dias.getUTCFullYear(), month: en7dias.getUTCMonth() + 1, day: en7dias.getUTCDate() },
          },
        },
        orb: 5,
        options: {
          active_points: ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Pluto', 'Neptune', 'Uranus'],
          fixed_stars: { language: 'es' },
        },
        report_options: { tradition: 'psychological', language: 'es' },
      });
      
      // Guardar para la próxima sesión (hoy + 7 días)
      if (transitoGuardado?.id) {
        await req.supabase.from('transitos_cache').update({
          fecha_hoy: hoyStr,
          datos_transitos: respuesta.data,
          updated_at: new Date().toISOString()
        }).eq('id', transitoGuardado.id);
      } else {
        await req.supabase.from('transitos_cache').insert({
          user_id: req.userId,
          fecha_hoy: hoyStr,
          datos_transitos: respuesta.data,
        }).maybeSingle();
      }
    }

    // OPTIMIZACIÓN (30 sept): Limitar a 10 eventos más importantes (evita procesar 50+)
    const eventosCrudos = respuesta.data?.data?.events || respuesta.data?.events || [];
    const obtenerFecha = (ev) => ev.date_local || ev.date || ev.exact_date || ev.transit_date || null;
    const en7diasStr = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    
    // Puntuación simple: aspectos buenos > malos, planetas lentos > rápidos
    const puntuarEvento = (ev) => {
      const esAspectoBueno = ['trine', 'sextile', 'conjunction'].includes(ev.aspect_type) ? 10 : -5;
      const esPlanetaLento = ['Saturn', 'Uranus', 'Neptune', 'Pluto', 'North_Node', 'Lilith'].includes(ev.transiting_planet) ? 5 : 0;
      return esAspectoBueno + esPlanetaLento;
    };
    
    const eventosOrdenados = eventosCrudos
      .filter(ev => {
        const f = obtenerFecha(ev);
        return f && f.slice(0, 10) >= hoyStr && f.slice(0, 10) <= en7diasStr;
      })
      .sort((a, b) => {
        // Primero por puntuación (eventos importantes primero)
        const puntA = puntuarEvento(a);
        const puntB = puntuarEvento(b);
        if (puntA !== puntB) return puntB - puntA;
        // Luego por fecha
        const fa = obtenerFecha(a), fb = obtenerFecha(b);
        if (!fa || !fb) return 0;
        return new Date(fa) - new Date(fb);
      })
      .slice(0, 10); // ← LIMITAR A 10

    // Inyectar los eventos ordenados de vuelta en la respuesta
    const datosLimpios = { ...respuesta.data };
    if (datosLimpios?.data?.events) datosLimpios.data.events = eventosOrdenados;
    else if (datosLimpios?.events) datosLimpios.events = eventosOrdenados;

    const respuestaTransitos = { transitos: datosLimpios };
    
    // OPTIMIZACIÓN (30 sept): NO traducir tránsitos - son datos técnicos
    // Son solo 10 eventos con campos: planeta, signo, aspecto. No necesitan traducción.
    // await traducirInterpretacionesEnObjeto(respuestaTransitos); ← SALTADO
    
    const cacheKey = cacheHash(req.userId, 'transitos', horaStr());
    cacheSet(cacheKey, respuestaTransitos, TTL.TRANSITOS_PERSONALES);
    res.json(respuestaTransitos);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudieron calcular los tránsitos.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/suscripcion/iniciar', requireLogin, async (req, res) => {
  try {
    const PRECIOS_POR_PLAN = {
      mensual: process.env.STRIPE_PRICE_ID,
      semestral: process.env.STRIPE_PRICE_ID_SEMESTRAL,
      anual: process.env.STRIPE_PRICE_ID_ANUAL,
    };
    const plan = PRECIOS_POR_PLAN[req.body?.plan] ? req.body.plan : 'mensual';
    const priceId = PRECIOS_POR_PLAN[plan];
    if (!priceId) return res.status(400).json({ error: `Falta configurar el precio de Stripe para el plan "${plan}".` });

    // Buscamos si ya existe un customer_id guardado; si no, creamos uno en Stripe
    const { data: subExistente } = await req.supabase
      .from('subscriptions')
      .select('stripe_customer_id, trial_used')
      .eq('user_id', req.userId)
      .maybeSingle();

    let customerId = subExistente?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.userEmail });
      customerId = customer.id;
      await req.supabase.from('subscriptions').upsert({
        user_id: req.userId,
        provider: 'stripe',
        stripe_customer_id: customerId,
        estado: 'pendiente',
      }, { onConflict: 'user_id' });
    }

    // No dar un segundo periodo de prueba a quien ya lo usó antes (aunque cancele y regrese, o reinstale)
    const yaUsoTrial = !!subExistente?.trial_used;

    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        ...(yaUsoTrial ? {} : { trial_period_days: 7 }),
        metadata: { user_id: req.userId, plan },
      },
      success_url: `${req.headers.origin || 'https://tuapp.com'}/pago-exitoso`,
      cancel_url: `${req.headers.origin || 'https://tuapp.com'}/pago-cancelado`,
      metadata: { user_id: req.userId, plan },
    });

    res.json({ url: sesionPago.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
});

// ============================================================
// RUTA: Validar y activar una compra nativa (Google Play Billing / Apple StoreKit).
//
// ⚠️ IMPORTANTE — ESTADO ACTUAL: para esta fase de PRUEBA CERRADA, esta ruta activa el
// acceso premium confiando en el comprobante que manda el cliente (purchaseToken/orderId),
// sin validarlo todavía contra el servidor de Google (eso requiere una cuenta de servicio
// de Google Cloud con acceso a la Android Publisher API, que aún no está configurada).
// Es aceptable para probar con testers conocidos (License Testing), pero ANTES de lanzar
// a producción pública hay que agregar la validación server-side real con esa API —
// si no, cualquiera podría fingir una compra falsa desde el navegador.
// ============================================================
app.post('/suscripcion/validar-compra-nativa', requireLogin, async (req, res) => {
  try {
    const { plataforma, plan, productId, purchaseToken, orderId, receipt, transactionId } = req.body || {};
    if (plataforma !== 'google_play' && plataforma !== 'app_store') {
      return res.status(400).json({ error: 'Plataforma de compra no reconocida.' });
    }
    // Android manda purchaseToken; iOS manda receipt o transactionId — cada plataforma tiene su propio comprobante
    const comprobante = plataforma === 'google_play' ? purchaseToken : (receipt || transactionId);
    if (!productId || !comprobante) {
      return res.status(400).json({ error: 'Faltan datos de la compra.' });
    }

    // TODO (antes de producción pública): validar purchaseToken con la Android Publisher API
    // (Google Play) o el receipt/transactionId con la App Store Server API (Apple), y usar
    // las fechas reales de expiración que esas APIs regresan, en vez de calcularlas aquí.
    const ahora = new Date();
    const finPeriodoEstimado = new Date(ahora);
    if (plan === 'anual') finPeriodoEstimado.setFullYear(finPeriodoEstimado.getFullYear() + 1);
    else if (plan === 'semestral') finPeriodoEstimado.setMonth(finPeriodoEstimado.getMonth() + 6);
    else finPeriodoEstimado.setMonth(finPeriodoEstimado.getMonth() + 1);

    await req.supabase.from('subscriptions').upsert({
      user_id: req.userId,
      provider: plataforma,
      product_id: productId,
      transaction_id: comprobante,
      estado: 'activa',
      start_date: ahora.toISOString(),
      expiration_date: finPeriodoEstimado.toISOString(),
      trial_used: true,
    }, { onConflict: 'user_id' });

    res.json({ mensaje: 'Suscripción activada.', proveedor: plataforma });
  } catch (err) {
    console.error('Error validando compra nativa:', err.message);
    res.status(500).json({ error: 'No se pudo validar la compra.' });
  }
});

// ============================================================
// RUTA: Webhook de Stripe (esqueleto, se activa al conectar dominio real)
// ============================================================
// RUTA: Abrir el portal de Stripe para gestionar/cancelar la suscripción
app.post('/suscripcion/portal', requireLogin, async (req, res) => {
  try {
    const { data: sub } = await req.supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return res.status(400).json({ error: 'Aún no tienes una suscripción activa para gestionar.' });
    }

    const sesion = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: req.headers.origin || 'https://tuapp.com',
    });

    res.json({ url: sesion.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo abrir el portal de pago.' });
  }
});

// ============================================================
// FASE 8 — DIARIO ASTROLÓGICO
// SQL requerido en Supabase:
// create table if not exists diario (
//   id uuid primary key default gen_random_uuid(),
//   user_id uuid references auth.users(id) on delete cascade,
//   fecha date not null default current_date,
//   hora_local time,
//   texto text,
//   estado_animo text,
//   categorias text[],
//   luna_signo text,
//   luna_fase text,
//   dia_personal integer,
//   created_at timestamptz default now()
// );
// create index on diario(user_id, fecha desc);
// ============================================================

app.post('/diario/guardar', requireLogin, async (req, res) => {
  try {
    const { texto, estado_animo, categorias } = req.body;
    if (!texto?.trim()) return res.status(400).json({ error: 'El texto del diario no puede estar vacío.' });

    const hoy = new Date();
    // Traer el snapshot lunar del día (si ya está en caché, no gasta créditos)
    const cacheKey = cacheHash(req.userId, ahora => ahora, hoy.toISOString().slice(0, 10));
    let lunaSigno = null, lunaFase = null, diaPersonal = null;
    try {
      const perfil = await leerPerfil(req);
      const [ciclos, luna] = await Promise.all([
        astrologyApi.post('/numerology/personal-cycles', {
          subject: birthDataDesdePerfil(perfil),
          target_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth()+1, day: hoy.getUTCDate() },
        }).catch(() => null),
        astrologyApi.post('/analysis/lunar-analysis', {
          datetime_location: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth()+1, day: hoy.getUTCDate(), hour: hoy.getUTCHours(), minute: 0, second: 0, city: perfil?.ciudad_nacimiento || 'Mexico City', country_code: perfil?.pais_codigo || 'MX' },
        }).catch(() => null),
      ]);
      lunaSigno = luna?.data?.data?.lunar_metrics?.moon_sign || null;
      lunaFase = luna?.data?.data?.lunar_metrics?.moon_phase || null;
      diaPersonal = ciclos?.data?.data?.personal_day?.number || null;
    } catch (e) { /* silencioso — el diario se guarda igual */ }

    const { data, error } = await req.supabase.from('diario').insert({
      user_id: req.userId,
      fecha: hoy.toISOString().slice(0, 10),
      hora_local: hoy.toTimeString().slice(0, 5),
      texto: texto.trim(),
      estado_animo: estado_animo || null,
      categorias: categorias || [],
      luna_signo: lunaSigno,
      luna_fase: lunaFase,
      dia_personal: diaPersonal,
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ entrada: data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo guardar en el diario.' });
  }
});

app.get('/diario', requireLogin, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('diario')
      .select('*')
      .eq('user_id', req.userId)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ entradas: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo leer el diario.' });
  }
});

app.delete('/diario/:id', requireLogin, async (req, res) => {
  try {
    await req.supabase.from('diario').delete().eq('id', req.params.id).eq('user_id', req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo eliminar la entrada.' });
  }
});

// ============================================================
// BIBLIOTECA DE CONOCIMIENTO (lectura pública, escritura solo admin)
// SQL:
// create table if not exists biblioteca (
//   id uuid primary key default gen_random_uuid(),
//   titulo text not null,
//   categoria text,
//   contenido text,
//   fuente text,
//   activo boolean default true,
//   created_at timestamptz default now()
// );
// ============================================================

app.get('/biblioteca', requireLogin, async (req, res) => {
  try {
    const categoria = req.query.categoria || null;
    let query = supabase.from('biblioteca').select('id, titulo, categoria, fuente, created_at').eq('activo', true).order('created_at', { ascending: false });
    if (categoria) query = query.eq('categoria', categoria);
    const { data, error } = await query.limit(50);
    if (error) return res.status(400).json({ error: error.message, debug_error: error });

    // Diagnóstico: si viene vacío, revisamos sin el filtro de activo para saber si el problema es ese filtro
    let debug = null;
    if (!data || data.length === 0) {
      const { data: sinFiltro, error: errorSinFiltro } = await supabase.from('biblioteca').select('id, activo').limit(5);
      debug = { total_sin_filtro_activo: sinFiltro?.length || 0, muestra: sinFiltro, error_sin_filtro: errorSinFiltro?.message || null };
    }

    res.json({ articulos: data || [], debug });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo cargar la biblioteca.', debug_catch: err.message });
  }
});

app.get('/biblioteca/:id', requireLogin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('biblioteca').select('*').eq('id', req.params.id).eq('activo', true).single();
    if (error || !data) return res.status(404).json({ error: 'Artículo no encontrado.' });
    res.json({ articulo: data });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo cargar el artículo.' });
  }
});

// Solo admin puede agregar (verificar email de Samantha)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'shernsndez.22@gmail.com';
app.post('/biblioteca', requireLogin, async (req, res) => {
  try {
    const { data: usuario } = await supabase.auth.admin.getUserById(req.userId).catch(() => ({ data: null }));
    const esAdmin = usuario?.user?.email === ADMIN_EMAIL || req.userEmail === ADMIN_EMAIL;
    if (!esAdmin) return res.status(403).json({ error: 'Solo la administradora puede agregar contenido.' });

    const { titulo, categoria, contenido, fuente } = req.body;
    if (!titulo?.trim() || !contenido?.trim()) return res.status(400).json({ error: 'Faltan título y contenido.' });

    const { data, error } = await supabase.from('biblioteca').insert({ titulo: titulo.trim(), categoria: categoria || 'General', contenido: contenido.trim(), fuente: fuente || null }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ articulo: data });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo guardar.' });
  }
});

app.delete('/biblioteca/:id', requireLogin, async (req, res) => {
  try {
    const { data: usuario } = await supabase.auth.admin.getUserById(req.userId).catch(() => ({ data: null }));
    const esAdmin = usuario?.user?.email === ADMIN_EMAIL || req.userEmail === ADMIN_EMAIL;
    if (!esAdmin) return res.status(403).json({ error: 'Solo la administradora puede eliminar contenido.' });
    await supabase.from('biblioteca').update({ activo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo eliminar.' });
  }
});

// ============================================================
// EVENTOS ASTROLÓGICOS — avisos personalizados por equinoccios, eclipses,
// cambios de planeta, etc. Los crea la admin y cada usuaria solo ve los
// que le tocan (por fecha vigente + su signo solar, o "todos").
// Tabla necesaria en Supabase (SQL ya provisto aparte):
// create table if not exists eventos_astrologicos (
//   id uuid primary key default gen_random_uuid(),
//   titulo text not null,
//   tipo text,
//   fecha_inicio date not null,
//   fecha_fin date not null,
//   signos_afectados text[] default null,   -- null = todos los signos
//   mensaje text not null,
//   activo boolean default true,
//   created_at timestamptz default now()
// );
// ============================================================

app.post('/eventos-astrologicos', requireLogin, async (req, res) => {
  try {
    const { data: usuario } = await supabase.auth.admin.getUserById(req.userId).catch(() => ({ data: null }));
    const esAdmin = usuario?.user?.email === ADMIN_EMAIL || req.userEmail === ADMIN_EMAIL;
    if (!esAdmin) return res.status(403).json({ error: 'Solo la administradora puede crear eventos.' });

    const { titulo, tipo, fecha_inicio, fecha_fin, signos_afectados, mensaje } = req.body;
    if (!titulo?.trim() || !fecha_inicio || !fecha_fin || !mensaje?.trim()) {
      return res.status(400).json({ error: 'Faltan título, fechas o mensaje.' });
    }
    // signos_afectados: array de abreviaturas (Ari, Tau, Gem...) o null/[] para "todos"
    const signos = Array.isArray(signos_afectados) && signos_afectados.length ? signos_afectados : null;

    const { data, error } = await supabase.from('eventos_astrologicos').insert({
      titulo: titulo.trim(), tipo: tipo || 'general', fecha_inicio, fecha_fin,
      signos_afectados: signos, mensaje: mensaje.trim(),
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ evento: data });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo guardar el evento.' });
  }
});

app.get('/eventos-astrologicos/activo', requireLogin, async (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const { data: eventos, error } = await supabase
      .from('eventos_astrologicos')
      .select('*')
      .eq('activo', true)
      .lte('fecha_inicio', hoy)
      .gte('fecha_fin', hoy)
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    if (!eventos?.length) return res.json({ evento: null });

    // Sacamos el signo solar de la usuaria desde su carta natal ya calculada
    const { data: carta } = await req.supabase
      .from('natal_charts')
      .select('datos_carta')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const posiciones = carta?.datos_carta?.chart_data?.planetary_positions || [];
    const sol = posiciones.find(p => p.name === 'Sun') || carta?.datos_carta?.subject_data?.sun;
    const signoSolar = sol?.sign || null;

    const evento = eventos.find(e => !e.signos_afectados || (signoSolar && e.signos_afectados.includes(signoSolar)));
    res.json({ evento: evento || null });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo revisar eventos.' });
  }
});

app.delete('/eventos-astrologicos/:id', requireLogin, async (req, res) => {
  try {
    const { data: usuario } = await supabase.auth.admin.getUserById(req.userId).catch(() => ({ data: null }));
    const esAdmin = usuario?.user?.email === ADMIN_EMAIL || req.userEmail === ADMIN_EMAIL;
    if (!esAdmin) return res.status(403).json({ error: 'Solo la administradora puede eliminar eventos.' });
    await supabase.from('eventos_astrologicos').update({ activo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo eliminar.' });
  }
});

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let evento;
  try {
    evento = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body.toString());
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const sb = supabase; // cliente admin para webhooks

  try {
    switch (evento.type) {
      case 'checkout.session.completed': {
        const session = evento.data.object;
        const userId = session.metadata?.user_id;
        const plan = session.metadata?.plan || null;
        if (userId && session.subscription) {
          // Traemos la suscripción completa de Stripe para saber si tuvo periodo de prueba y sus fechas reales
          let subStripe = null;
          try { subStripe = await stripe.subscriptions.retrieve(session.subscription); } catch (e) { /* seguimos con lo que hay */ }
          await sb.from('subscriptions').upsert({
            user_id: userId,
            provider: 'stripe',
            product_id: plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            transaction_id: session.subscription,
            estado: 'activa',
            start_date: subStripe?.current_period_start ? new Date(subStripe.current_period_start * 1000).toISOString() : new Date().toISOString(),
            expiration_date: subStripe?.current_period_end ? new Date(subStripe.current_period_end * 1000).toISOString() : null,
            trial_used: !!subStripe?.trial_end || true,
          }, { onConflict: 'user_id' });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = evento.data.object;
        const { data: perfil } = await sb.from('subscriptions').select('user_id').eq('stripe_subscription_id', sub.id).maybeSingle();
        if (perfil) {
          const estado = (sub.status === 'active' || sub.status === 'trialing') ? 'activa' : sub.status === 'past_due' ? 'vencida' : 'cancelada';
          await sb.from('subscriptions').update({
            estado,
            expiration_date: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          }).eq('stripe_subscription_id', sub.id);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = evento.data.object;
        await sb.from('subscriptions').update({ estado: 'cancelada' }).eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = evento.data.object;
        if (invoice.subscription) {
          await sb.from('subscriptions').update({ estado: 'vencida' }).eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.json({ recibido: true });
});

// ============================================================
// Arrancar el servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sam Alquimia Astral backend corriendo en http://localhost:${PORT}`);
});