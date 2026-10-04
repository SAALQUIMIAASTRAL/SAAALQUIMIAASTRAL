// ============================================================
// SAM ALQUIMIA ASTRAL — Servidor (el "cerebro" de la app)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  next();
});
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.json()(req, res, next);
});
app.use(express.static('public'));

// ---- Caché en memoria con limpieza automática ----
const memoriaCache = new Map();
const MAX_CACHE_ENTRADAS = 2000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let bytesCache = 0;
function cacheBorrar(clave) {
  const anterior = memoriaCache.get(clave);
  if (anterior) bytesCache -= anterior.bytes || 0;
  memoriaCache.delete(clave);
}
function cacheGet(clave) {
  const item = memoriaCache.get(clave);
  if (!item) return null;
  if (Date.now() >= item.expira) { cacheBorrar(clave); return null; }
  memoriaCache.delete(clave);
  memoriaCache.set(clave, item);
  return item.valor;
}
function cacheSet(clave, valor, ttlMs) {
  cacheBorrar(clave);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(valor), 'utf8'); }
  catch (_) { return; }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || bytes > MAX_CACHE_BYTES) return;
  while (memoriaCache.size >= MAX_CACHE_ENTRADAS || bytesCache + bytes > MAX_CACHE_BYTES) {
    cacheBorrar(memoriaCache.keys().next().value);
  }
  memoriaCache.set(clave, { valor, expira:Date.now()+ttlMs, bytes });
  bytesCache += bytes;
}
function cacheHash(...partes) {
  return crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}

// Limpieza automática cada 10 min — evita fugas de memoria
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, item] of memoriaCache.entries()) {
    if (ahora >= item.expira) cacheBorrar(clave);
  }
  if (Object.values(metricasAhorro).some(v => v > 0)) {
    console.info('Reutilización de consultas', { ...metricasAhorro, entradas:memoriaCache.size, bytes:bytesCache });
    Object.keys(metricasAhorro).forEach(k => { metricasAhorro[k] = 0; });
  }
}, 10 * 60 * 1000);

// Reutilización acotada y consultas simultáneas (sin datos personales en los registros).
const consultasEnCurso = new Map();
const metricasAhorro = { compartidas:0, memoria:0, persistente:0, calculadas:0 };
function claveAhorro(...partes) {
  function ordenar(valor) {
    if (Array.isArray(valor)) return valor.map(ordenar);
    if (!valor || typeof valor !== 'object') return valor;
    return Object.fromEntries(Object.keys(valor).sort().map(k => [k, ordenar(valor[k])]));
  }
  return crypto.createHash('sha256').update(JSON.stringify(ordenar(partes))).digest('hex');
}
async function consultaUnica(clave, calcular) {
  if (consultasEnCurso.has(clave)) {
    metricasAhorro.compartidas++;
    return consultasEnCurso.get(clave);
  }
  const tarea = Promise.resolve().then(calcular);
  consultasEnCurso.set(clave, tarea);
  try { return await tarea; }
  finally { if (consultasEnCurso.get(clave) === tarea) consultasEnCurso.delete(clave); }
}
// Solo para JSON de rutas autenticadas. No conserva la respuesta después de terminar.
function rutaSinDuplicados(nombre, handler) {
  return async (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error:'Inicia sesión.' });
    const clave = claveAhorro('ruta-v1', nombre, req.userId, req.params || {}, req.body || {}, zonaHorariaDesdeReq(req));
    try {
      const resultado = await consultaUnica(clave, async () => {
        let codigo = 200, respuesta, enviada = false;
        const salida = {
          status(valor) { codigo = valor; return salida; },
          json(valor) { respuesta = valor; enviada = true; return salida; }
        };
        await handler(req, salida);
        if (!enviada) throw new Error('La consulta no devolvió una respuesta.');
        return { codigo, respuesta };
      });
      return res.status(resultado.codigo).json(resultado.respuesta);
    } catch (err) { return next(err); }
  };
}
// Activar solo en el servicio de pruebas tras habilitar su tabla de caché pública.
const CACHE_CIELO_PERSISTENTE = process.env.CACHE_CIELO_PERSISTENTE === 'true';
// La tabla compartida se usa EXCLUSIVAMENTE para cielo público, nunca para cartas o traducciones.
async function cacheCieloPublico(clave, ttl, calcular, forzar = false) {
  const llave = 'cielo-publico-v1-' + claveAhorro(clave);
  return consultaUnica(llave, async () => {
    if (!forzar) {
      const local = cacheGet(llave);
      if (local !== null) { metricasAhorro.memoria++; return JSON.parse(JSON.stringify(local)); }
      if (CACHE_CIELO_PERSISTENTE) try {
        const { data, error } = await supabase.from('cache_persistente').select('datos').eq('clave', llave).maybeSingle();
        const guardado = data?.datos;
        if (!error && guardado?.version === 1 && guardado.expira > Date.now() && guardado.valor != null) {
          cacheSet(llave, guardado.valor, guardado.expira - Date.now());
          metricasAhorro.persistente++;
          return JSON.parse(JSON.stringify(guardado.valor));
        }
      } catch (_) { /* La caché es una optimización: no bloquea el cálculo. */ }
    }
    const valor = await calcular();
    metricasAhorro.calculadas++;
    cacheSet(llave, valor, ttl);
    if (CACHE_CIELO_PERSISTENTE) try {
      const { error } = await supabase.from('cache_persistente').upsert({
        clave:llave, datos:{ version:1, expira:Date.now()+ttl, valor }, updated_at:new Date().toISOString()
      }, { onConflict:'clave' });
      if (error) console.warn('No se pudo guardar la caché pública:', error.code || 'error');
    } catch (_) { console.warn('No se pudo guardar la caché pública.'); }
    return JSON.parse(JSON.stringify(valor));
  });
}

const TTL = {
  PERFIL: 5 * 60 * 1000,                 // 5 min
  TRANSITOS_HOY: 30 * 60 * 1000,         // 30 min (compartida entre usuarios)
  LUNA: 30 * 60 * 1000,                  // 30 min
  HOROSCOPO: 2 * 60 * 60 * 1000,         // 2 hrs (cambia poco en el día)
  ENERGIA_DIA: 60 * 60 * 1000,           // 1 hr
  TRANSITOS_PERSONALES: 2 * 60 * 60 * 1000, // 2 hrs
  ECLIPSES: 48 * 60 * 60 * 1000,         // 48 hrs (cambian muy poco)
  CALENDARIO_LUNAR: 12 * 60 * 60 * 1000, // 12 hrs
  ASTROCARTOGRAFIA: 24 * 60 * 60 * 1000, // 24 hrs (estática basada en nacimiento)
  NUMEROLOGIA: 24 * 60 * 60 * 1000,      // 24 hrs (día personal cambia a medianoche)
  ESTRELLAS: 7 * 24 * 60 * 60 * 1000,    // 7 días (prácticamente estática)
};

// Helpers de tiempo.
// Regla de arquitectura: UTC para el instante astronómico; zona horaria del dispositivo
// únicamente para decidir qué fecha/hora ve la persona ("hoy", calendario, numerología, etc.).
const hoyStr = () => new Date().toISOString().slice(0, 10);
const horaStr = () => new Date().toISOString().slice(0, 13);

function normalizarZonaHoraria(tz) {
  const candidata = (tz || '').trim();
  if (!candidata) return 'America/Mexico_City';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidata }).format(new Date());
    return candidata;
  } catch (e) {
    return 'America/Mexico_City';
  }
}

function zonaHorariaDesdeReq(req) {
  return normalizarZonaHoraria(req.headers['x-timezone'] || req.body?.timezone);
}

function partesEnZona(tz, instante = new Date()) {
  const zona = normalizarZonaHoraria(tz);
  try {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instante);
    const leer = tipo => parseInt(partes.find(p => p.type === tipo)?.value || '0', 10);
    return {
      year: leer('year'), month: leer('month'), day: leer('day'),
      hour: leer('hour'), minute: leer('minute'), timezone: zona,
    };
  } catch (e) {
    return {
      year: instante.getUTCFullYear(), month: instante.getUTCMonth()+1, day: instante.getUTCDate(),
      hour: instante.getUTCHours(), minute: instante.getUTCMinutes(), timezone: 'UTC',
    };
  }
}

function fechaLocalMexico(tz) {
  const p = partesEnZona(tz);
  return `${String(p.year).padStart(4,'0')}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

function ahoraMexico(tz) {
  return partesEnZona(tz);
}

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
function normalizarEspanolMX(texto) {
  if (typeof texto !== 'string') return texto;
  return texto
    .replace(/\b(vuestra|vuestro|vuestras|vuestros)\b/gi, (p) => ({vuestra:'su',vuestro:'su',vuestras:'sus',vuestros:'sus'}[p.toLowerCase()]))
    .replace(/\bvosotros\b/gi, 'ustedes')
    .replace(/\bvosotras\b/gi, 'ustedes')
    .replace(/\balinearos\b/gi, 'ponerse de acuerdo')
    .replace(/\bcomunicaros\b/gi, 'comunicarse')
    .replace(/\bentenderos\b/gi, 'entenderse')
    .replace(/\bconoceros\b/gi, 'conocerse')
    .replace(/\bapoyaros\b/gi, 'apoyarse')
    .replace(/\bencontráis\b/gi, 'encuentran')
    .replace(/\bpodéis\b/gi, 'pueden')
    .replace(/\btenéis\b/gi, 'tienen')
    .replace(/\bsois\b/gi, 'son')
    .replace(/\bqueréis\b/gi, 'quieren')
    .replace(/\bnecesitáis\b/gi, 'necesitan')
    .replace(/\bsentís\b/gi, 'sienten')
    .replace(/\bhacéis\b/gi, 'hacen')
    .replace(/\bdebéis\b/gi, 'deben')
    .replace(/\bvos\b/gi, 'tú')
    .replace(/\btenés\b/gi, 'tienes')
    .replace(/\bpodés\b/gi, 'puedes')
    .replace(/\bquerés\b/gi, 'quieres')
    .replace(/\bsos\b/gi, 'eres')
    .replace(/\bordenador\b/gi, 'computadora')
    .replace(/\bmóvil\b/gi, 'celular');
}

async function traducirBloqueSinCache(lista) {
  lista = lista.map(normalizarEspanolMX);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('traducirBloque: falta ANTHROPIC_API_KEY en las variables de entorno');
    return { textos: lista, debug: 'Falta la variable de entorno ANTHROPIC_API_KEY en Render.' };
  }
  try {
    const prompt = `Reescribe cada texto astrológico en español de México, dirigido de tú a una persona y de ustedes a dos personas. Usa su relación y entre ustedes. Nunca uses vosotros, vuestro, vuestra, vos, sois, tenéis, podéis, os ni verbos como alinearos. No mezcles inglés ni portugués. Conserva las tildes correctas, los nombres propios, planetas, signos, casas, aspectos, fechas y cifras; no inventes datos ni cambies el significado. Explica de forma breve y concreta qué significa cada dato en situaciones cotidianas. Evita frases vacías como esta área respalda bien su relación, alinear energías o potenciar la conexión: expresa la facilidad o dificultad específica descrita por el texto. No prometas resultados ni añadas rasgos que no aparecen en el original. Conserva la estructura de párrafos. Responde ÚNICAMENTE con un array JSON de strings en el mismo orden, sin explicación ni markdown:\n\n${JSON.stringify(lista)}`;
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
    if (!Array.isArray(traducidos) || traducidos.length !== lista.length || traducidos.some(t => typeof t !== 'string' || !t.trim())) {
      console.error('traducirBloque: tamaño no coincide. Esperado', lista.length, 'recibido', Array.isArray(traducidos) ? traducidos.length : typeof traducidos);
      return { textos: lista, debug: `Array no coincide en tamaño. Esperado ${lista.length}, recibido ${Array.isArray(traducidos) ? traducidos.length : typeof traducidos}` };
    }
    return { textos: traducidos.map(normalizarEspanolMX), debug: null };
  } catch (e) {
    console.error('traducirBloque falló:', e.message);
    return { textos: lista, debug: 'Excepción: ' + e.message };
  }
}

// Traduce una lista completa dividiéndola en bloques de 25 (respuestas grandes como
// sinastría pueden traer 60+ textos, y un solo bloque gigante es más frágil/lento)
async function traducirBloque(lista) {
  const clave = claveAhorro('traduccion-es-MX-v2', lista);
  return consultaUnica(clave, async () => {
    const guardado = cacheGet(clave);
    if (guardado !== null) return { textos:[...guardado] };
    const resultado = await traducirBloqueSinCache(lista);
    if (!resultado.debug && Array.isArray(resultado.textos) && resultado.textos.length === lista.length) {
      cacheSet(clave, resultado.textos, 7 * 24 * 60 * 60 * 1000);
    }
    return resultado;
  });
}

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
async function traducirInterpretacionesEnObjeto(raiz) {
  const objetos = [];
  function buscar(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(buscar); return; }
    for (const campo of CAMPOS_INTERPRETATIVOS) {
      if (typeof obj[campo] === 'string' && obj[campo].trim().length > 3) objetos.push({ obj, campo });
      else if (Array.isArray(obj[campo])) obj[campo].forEach((texto, indice) => {
        if (typeof texto === 'string' && texto.trim().length > 3) objetos.push({ obj:obj[campo], campo:indice });
      });
    }
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') buscar(obj[key]);
    }
  }
  buscar(raiz);
  if (!objetos.length) return 0;
  const { textos: traducidos } = await traducirTextosConIA(objetos.map(o => o.obj[o.campo]));
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
  const prompt = `Eres una astróloga profesional escribiendo un análisis de personalidad en español de México, de tú, cálido pero profesional, para alguien SIN conocimientos de astrología. No uses vosotros, vuestro, vuestra, vos ni formas verbales de España. Usa ejemplos cotidianos concretos, sin frases genéricas y sin mezclar idiomas.

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

// Luna actual GLOBAL: se calcula una vez por bloque de 30 minutos y se comparte.
// La Luna/fase/signo del instante no depende de la carta natal de cada usuaria.
// Usamos UTC + Greenwich para representar un instante absoluto y evitar mezclar
// la hora actual del teléfono con la ciudad de nacimiento.
async function obtenerLunaGlobalActual() {
  const bloque30m = Math.floor(Date.now() / TTL.LUNA);
  const cacheKey = cacheHash('luna-global-v2', bloque30m);
  return cacheCieloPublico(cacheKey, TTL.LUNA, async () => {
  const ahora = new Date();
  const respuesta = await astrologyApi.post('/analysis/lunar-analysis', {
    datetime_location: {
      year: ahora.getUTCFullYear(),
      month: ahora.getUTCMonth() + 1,
      day: ahora.getUTCDate(),
      hour: ahora.getUTCHours(),
      minute: ahora.getUTCMinutes(),
      second: ahora.getUTCSeconds(),
      city: 'Greenwich',
      country_code: 'GB',
    },
    report_options: { language: 'es' },
  });

  const respuestaLuna = { mensaje: 'Datos lunares actuales', luna: respuesta.data };
  await traducirInterpretacionesEnObjeto(respuestaLuna);
  return respuestaLuna;
  });
}


// Cielo actual GLOBAL: posiciones planetarias del instante, compartidas por todas las usuarias.
// Se calcula una vez por bloque de 30 minutos para evitar repetir la misma llamada externa.
async function obtenerCieloGlobalActual() {
  const bloque30m = Math.floor(Date.now() / TTL.TRANSITOS_HOY);
  const cacheKey = cacheHash('cielo-global-v1', bloque30m);
  return cacheCieloPublico(cacheKey, TTL.TRANSITOS_HOY, async () => {
  const ahora = new Date();
  const respuesta = await astrologyApi.post('/charts/natal', {
    subject: {
      name: 'Cielo actual',
      birth_data: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: ahora.getUTCHours(),
        minute: ahora.getUTCMinutes(),
        second: ahora.getUTCSeconds(),
        city: 'Greenwich',
        country_code: 'GB',
      },
    },
    options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
  });

  const cielo = { mensaje: 'Cielo actual', datos_hoy: respuesta.data };
  return cielo;
  });
}

// ============================================================
// Middleware: verifica que la usuaria haya iniciado sesión
// ============================================================
async function requireLogin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const coincidencia = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!coincidencia) return res.status(401).json({ error: 'No iniciaste sesión.' });
  const token = coincidencia[1];
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    req.userId = data.user.id;
    req.userEmail = data.user.email;
    req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    next();
  } catch (_) {
    return res.status(503).json({ error: 'No pudimos comprobar tu sesión. Inténtalo de nuevo.' });
  }
}

async function requirePremium(req, res, next) {
  try {
    const { data: sub, error } = await supabase.from('subscriptions').select('estado').eq('user_id', req.userId).maybeSingle();
    if (error) return res.status(503).json({ error: 'No pudimos comprobar tu suscripción. Inténtalo de nuevo.' });
    const esAdmin = req.userEmail === (process.env.ADMIN_EMAIL || 'shernsndez.22@gmail.com');
    if (!esAdmin && sub?.estado !== 'activa') {
      return res.status(403).json({ error: 'Esta función requiere una suscripción activa.', premium_required: true });
    }
    next();
  } catch (_) {
    return res.status(503).json({ error: 'No pudimos comprobar tu suscripción. Inténtalo de nuevo.' });
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
// Cada operación pública de Auth usa su propio cliente: no altera la sesión del cliente admin.
function clienteAuthPublico() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth:{ persistSession:false, autoRefreshToken:false, detectSessionInUrl:false, flowType:'implicit' }
  });
}
function urlPublicaAuth(req) {
  const host = req.get('host') || '';
  // El servicio de pruebas debe volver a pruebas incluso si heredó APP_PUBLIC_URL de PRD.
  const pruebas = /^[a-z0-9-]*pruebas[a-z0-9-]*\.onrender\.com$/i.test(host);
  const base = pruebas ? 'https://' + host : (process.env.AUTH_PUBLIC_URL || process.env.APP_PUBLIC_URL || req.protocol + '://' + host);
  const url = new URL(base);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('URL pública inválida.');
  return url.origin;
}
function correoValido(email) { return typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
async function correoCuentaEliminada(email, userId) {
  // Activar solo en el servicio de pruebas con remitente verificado. No usa IA ni tokens.
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { enviado:false, motivo:'sin_configurar' };
  const texto = 'Tu cuenta de Sam Alquimia Astral fue eliminada a tu solicitud. Ya no podrás iniciar sesión con esa cuenta. Gracias por haber compartido este espacio. Si no solicitaste la eliminación, escribe a soporte@samalquimiaastral.com.\n\nSam | Alquimia Astral';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json',
        'Idempotency-Key':'cuenta-eliminada-' + claveAhorro(userId) },
      body:JSON.stringify({ from:process.env.EMAIL_FROM, to:[email], subject:'Tu cuenta fue eliminada · Sam Alquimia Astral',
        text:texto, html:'<div style="font-family:Arial,sans-serif;color:#2D1B4E;max-width:560px;margin:auto;padding:28px;border:1px solid #E5E0EA;border-radius:16px;"><p style="color:#9B7A2E;">Sam | Alquimia Astral</p><h1 style="font-family:Georgia,serif;font-size:26px;">Tu cuenta fue eliminada</h1><p>Confirmamos la eliminación de tu cuenta a tu solicitud. Ya no podrás iniciar sesión con esa cuenta.</p><p>Gracias por haber compartido este espacio.</p><p>Si no solicitaste la eliminación, escribe a <a href="mailto:soporte@samalquimiaastral.com">soporte@samalquimiaastral.com</a>.</p><p>Sam | Alquimia Astral</p></div>' }),
      signal:AbortSignal.timeout(10000)
    });
    return { enviado:r.ok, motivo:r.ok ? null : 'proveedor_no_disponible' };
  } catch (_) { return { enviado:false, motivo:'proveedor_no_disponible' }; }
}

app.post('/auth/registro', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const { password, nombre } = req.body || {};
    if (!correoValido(email) || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error:'Escribe un correo válido y una contraseña de al menos 6 caracteres.' });
    const { data, error } = await clienteAuthPublico().auth.signUp({
      email, password,
      options:{ data:{ nombre:String(nombre || '').trim().slice(0,100) }, emailRedirectTo:urlPublicaAuth(req) + '/confirmar.html' }
    });
    if (error) return res.status(400).json({ error:'No se pudo crear la cuenta. Revisa tus datos o intenta de nuevo más tarde.' });
    res.json({ mensaje:data.session ? 'Cuenta creada' : 'Revisa tu correo para confirmar tu cuenta.',
      usuario:data.user, sesion:data.session || null, necesita_confirmacion:!data.session });
  } catch (_) { res.status(503).json({ error:'No se pudo crear la cuenta. Intenta de nuevo.' }); }
});

// ============================================================
// RUTA: Inicio de sesión
// ============================================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await clienteAuthPublico().auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ sesion: data.session, usuario: data.user });
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Falta el refresh_token.' });
  const { data, error } = await clienteAuthPublico().auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
  res.json({ sesion: data.session });
});

// ============================================================
// RUTA: Solicitar recuperación de contraseña (envía correo con link)
// ============================================================
app.post('/auth/confirmacion', async (req, res) => {
  try {
    const token = req.body?.access_token;
    if (typeof token !== 'string' || !token) return res.status(400).json({ error:'El enlace no es válido.' });
    const { data, error } = await clienteAuthPublico().auth.getUser(token);
    if (error || !data.user?.email_confirmed_at) return res.status(400).json({ error:'El enlace no es válido o ya venció.' });
    res.json({ confirmado:true });
  } catch (_) { res.status(503).json({ error:'No se pudo comprobar el correo. Intenta iniciar sesión.' }); }
});

app.post('/auth/olvide-password', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!correoValido(email)) return res.status(400).json({ error:'Escribe un correo válido.' });
  try {
    const { error } = await clienteAuthPublico().auth.resetPasswordForEmail(email, {
      redirectTo:urlPublicaAuth(req) + '/restablecer.html'
    });
    if (error) return res.status(error.status === 429 ? 429 : 503).json({ error:error.status === 429 ? 'Espera un minuto antes de pedir otro enlace.' : 'No se pudo enviar el enlace. Intenta de nuevo más tarde.' });
    res.json({ mensaje:'Si ese correo está registrado, recibirás un enlace. Revisa tu bandeja y spam.' });
  } catch (_) { res.status(503).json({ error:'No se pudo enviar el enlace. Intenta de nuevo.' }); }
});

// ============================================================
// RUTA: Completar el restablecimiento con el token que llega en el link del correo
// ============================================================
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

  // Leemos el perfil anterior antes de guardar. Así distinguimos una edición del nombre
  // de un cambio real en los datos natales y no borramos/recalculamos la carta sin necesidad.
  const { data: perfilAnterior } = await req.supabase
    .from('profiles')
    .select('*')
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
  // Solo actualizamos coordenadas si vienen (evita borrar unas ya guardadas al editar solo el nombre, por ejemplo)
  if (typeof latitud === 'number' && !isNaN(latitud)) datosAGuardar.latitud = latitud;
  if (typeof longitud === 'number' && !isNaN(longitud)) datosAGuardar.longitud = longitud;

  const { data, error } = await req.supabase
    .from('profiles')
    .upsert(datosAGuardar)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  cacheBorrar(cacheHash('perfil', req.userId));

  const normalizarNumero = v => (v === null || v === undefined || v === '' ? null : Number(v));
  const cambioNatal = !perfilAnterior || [
    ['fecha_nacimiento', perfilAnterior?.fecha_nacimiento, fecha_nacimiento],
    ['hora_nacimiento', String(perfilAnterior?.hora_nacimiento || '').slice(0,5), String(hora_nacimiento || '').slice(0,5)],
    ['ciudad_nacimiento', perfilAnterior?.ciudad_nacimiento, ciudad_nacimiento],
    ['pais_codigo', perfilAnterior?.pais_codigo, pais_codigo],
    ['latitud', normalizarNumero(perfilAnterior?.latitud), normalizarNumero(latitud ?? perfilAnterior?.latitud)],
    ['longitud', normalizarNumero(perfilAnterior?.longitud), normalizarNumero(longitud ?? perfilAnterior?.longitud)],
  ].some(([, anterior, nuevo]) => String(anterior ?? '') !== String(nuevo ?? ''));

  // Solo una modificación REAL de nacimiento invalida carta y cálculos derivados.
  // Cambiar nombre, foto u otros datos de perfil ya no destruye una carta natal válida.
  if (cambioNatal) {
    const hoy = new Date();
    const anioActual = hoy.getUTCFullYear();
    const mesActual = hoy.getUTCMonth() + 1;
    cacheBorrar(cacheHash(req.userId, 'acg', 'propia'));
    cacheBorrar(cacheHash(req.userId, 'estrellas', 'propia'));
    cacheBorrar(cacheHash(req.userId, 'calendario-lunar', `${anioActual}-${mesActual}`));
    cacheBorrar(cacheHash(req.userId, 'home', hoyStr()));
    cacheBorrar(cacheHash(req.userId, 'numerologia', 'propia', hoyStr()));
    cacheBorrar(cacheHash(req.userId, 'energia', hoyStr()));
    cacheBorrar(cacheHash(req.userId, 'horoscopo', hoyStr()));
    await req.supabase.from('natal_charts').delete().eq('user_id', req.userId);
  }

  res.json({ mensaje: 'Perfil guardado', perfil: data, cambio_natal: cambioNatal });
});

// RUTA: Leer el perfil actual de la usuaria
app.get('/perfil', requireLogin, async (req, res) => {
  const [{ data, error }, { data: sub }] = await Promise.all([
    req.supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle(),
    req.supabase.from('subscriptions').select('estado').eq('user_id', req.userId).maybeSingle(),
  ]);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ perfil: data, suscripcion: sub?.estado || 'ninguna' });
});

// ============================================================
// RUTA: Calcular la carta natal REAL (texto: Sol, Luna, etc.)
// ============================================================
app.post('/carta-natal', requireLogin, rutaSinDuplicados('/carta-natal', async (req, res) => {
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
}));

// ============================================================
// RUTA: Generar la carta natal VISUAL (la "rueda" en SVG)
// ============================================================
app.post('/carta-visual', requireLogin, rutaSinDuplicados('/carta-visual', async (req, res) => {
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
}));

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
app.post('/resumen-natal', requireLogin, rutaSinDuplicados('/resumen-natal', async (req, res) => {
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

    const sintesis10 = await sintetizarPersonalidad10Bloques(respuesta.data?.data?.interpretations || []);
    const reporteFinal = { ...respuesta.data, sintesis_10: sintesis10 };

    if (cartaExistente?.id) {
      await req.supabase.from('natal_charts').update({ resumen_cache: reporteFinal }).eq('id', cartaExistente.id);
    }

    res.json({ reporte: reporteFinal, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el resumen.', detalle_tecnico: err?.response?.data || err.message });
  }
}));

app.post('/luna', requireLogin, async (req, res) => {
  try {
    const tz = zonaHorariaDesdeReq(req);
    const local = partesEnZona(tz);
    const respuestaLuna = await obtenerLunaGlobalActual();

    res.json({
      ...respuestaLuna,
      contexto_tiempo: {
        timezone: local.timezone,
        fecha_local: `${String(local.year).padStart(4,'0')}-${String(local.month).padStart(2,'0')}-${String(local.day).padStart(2,'0')}`,
        hora_local: `${String(local.hour).padStart(2,'0')}:${String(local.minute).padStart(2,'0')}`,
      },
    });
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
    const tz = zonaHorariaDesdeReq(req);
    const local = partesEnZona(tz);
    const fechaLocal = `${String(local.year).padStart(4,'0')}-${String(local.month).padStart(2,'0')}-${String(local.day).padStart(2,'0')}`;

    // La Luna Vacía de Curso es un fenómeno del cielo actual, no de la ciudad de nacimiento.
    // La clave incluye la fecha local solo para que la interfaz no "salte" de día por UTC.
    const bloque30m = Math.floor(Date.now() / TTL.LUNA);
    const cacheKey = cacheHash('luna-vacia-global-v2', bloque30m);
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ ...cached, contexto_tiempo: { timezone: local.timezone, fecha_local: fechaLocal } });
    }

    const ahora = new Date();
    const respuesta = await astrologyApi.post('/lunar/void-of-course', {
      datetime_location: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: ahora.getUTCHours(),
        minute: ahora.getUTCMinutes(),
        second: ahora.getUTCSeconds(),
        city: 'Greenwich',
        country_code: 'GB',
      },
    });

    const respuestaVoC = { mensaje: 'Luna vacía actual', voc: respuesta.data };
    cacheSet(cacheKey, respuestaVoC, TTL.LUNA);
    res.json({
      ...respuestaVoC,
      contexto_tiempo: { timezone: local.timezone, fecha_local: fechaLocal },
    });
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

    const tz = zonaHorariaDesdeReq(req);
    const ahora = partesEnZona(tz);
    const fechaLocal = `${String(ahora.year).padStart(4,'0')}-${String(ahora.month).padStart(2,'0')}-${String(ahora.day).padStart(2,'0')}`;
    const cacheKey = cacheHash(req.userId, 'home-v2', fechaLocal);
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, nombre: perfil.nombre });

    // Luna global compartida + cálculos realmente personales en paralelo.
    const [lunaGlobal, ciclosData, transitosHoyData] = await Promise.all([
      obtenerLunaGlobalActual().catch(() => null),
      astrologyApi.post('/numerology/personal-cycles', {
        subject: birthDataDesdePerfil(perfil),
        target_date: { year: ahora.year, month: ahora.month, day: ahora.day },
        language: 'es',
      }).catch(() => null),
      obtenerCieloGlobalActual().catch(() => null),
    ]);

    const luna = lunaGlobal?.luna?.data?.lunar_metrics;
    const diaPersonal = ciclosData?.data?.data?.personal_day?.number || null;
    const anioPersonal = ciclosData?.data?.data?.personal_year?.number || null;
    const planetasHoy = transitosHoyData?.datos_hoy?.subject_data || transitosHoyData?.datos_hoy?.data?.subject_data || null;

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
      luna: luna ? {
        signo: luna.moon_sign,
        fase: luna.moon_phase,
        iluminacion: Math.round(luna.moon_illumination),
        dia_lunar: luna.moon_day,
      } : null,
      dia_personal: diaPersonal,
      anio_personal: anioPersonal,
      transito_principal: transitoPrincipal,
      fecha_local: fechaLocal,
      hora_local: ahora.hour,
      timezone: ahora.timezone,
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

    const cielo = await obtenerCieloGlobalActual();
    res.json({ ...cielo, nombre: perfil.nombre });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo obtener el cielo de hoy.' });
  }
});

app.post('/astrocartografia', requireLogin, async (req, res) => {
  try {
    const otraCartaId = req.body?.otra_carta_id || null;
    const cacheKey = cacheHash(req.userId, 'acg', otraCartaId || 'propia');
    
    // Primero caché en memoria
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    
    // Luego caché persistente en Supabase
    const { data: cachedPers } = await supabase.from('cache_persistente')
      .select('valor').eq('clave', cacheKey).maybeSingle();
    if (cachedPers?.valor) {
      const parsed = JSON.parse(cachedPers.valor);
      cacheSet(cacheKey, parsed, 30 * 24 * 60 * 60 * 1000);
      return res.json(parsed);
    }

    let datosSubject;
    if (otraCartaId) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', otraCartaId).single();
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
    cacheSet(cacheKey, respuestaACG, TTL.ASTROCARTOGRAFIA);
    // Guardar en Supabase para sobrevivir reinicios de Render
    supabase.from('cache_persistente').upsert({ clave: cacheKey, valor: JSON.stringify(respuestaACG) }).then(() => {}).catch(() => {});
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
    contexto += `Responde en español de México, de tú, con ejemplos concretos; sin vosotros, vuestro, vuestra ni formas de España. Evita frases genéricas y no mezcles idiomas. Máximo 150 palabras. No inventes posiciones planetarias — solo usa las que te dí.`;

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

app.delete('/mi-cuenta', requireLogin, rutaSinDuplicados('/mi-cuenta', async (req, res) => {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error:'No se pudo eliminar la cuenta. Contacta con soporte.' });
    const correo = req.userEmail;
    const resultados = await Promise.all([
      req.supabase.from('diario').delete().eq('user_id', req.userId),
      req.supabase.from('natal_charts').delete().eq('user_id', req.userId),
      req.supabase.from('otras_cartas').delete().eq('user_id', req.userId),
      req.supabase.from('subscriptions').delete().eq('user_id', req.userId),
      req.supabase.from('feedback').delete().eq('user_id', req.userId),
    ]);
    if (resultados.some(r => r.error)) throw new Error('No se completó la eliminación de los datos.');
    const perfil = await req.supabase.from('profiles').delete().eq('id', req.userId);
    if (perfil.error) throw new Error('No se pudo eliminar el perfil.');
    const eliminacion = await supabase.auth.admin.deleteUser(req.userId);
    if (eliminacion.error) throw new Error('No se pudo eliminar el acceso.');
    const aviso = correoValido(correo) ? await correoCuentaEliminada(correo, req.userId) : { enviado:false };
    if (!aviso.enviado) console.warn('Aviso de eliminación pendiente:', aviso.motivo || 'correo_no_disponible');
    res.json({ ok:true, mensaje:'Cuenta eliminada.', correo_eliminacion_enviado:aviso.enviado });
  } catch (_) { res.status(500).json({ error:'No se pudo completar la eliminación. Contacta con soporte antes de volver a intentarlo.' }); }
}));

app.post('/carta-compuesta', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

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

    res.json({
      carta_compuesta: compuesta.data || compuesta,
      dinamica_ahora: dinamica.data || dinamica,
      reseña: reseñaCompuesta?.data || null,
    });
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
        await traducirInterpretacionesEnObjeto(persona.sinastria_cache);
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

    const interpretacionesTraducidas = await traducirInterpretacionesEnObjeto(respuesta.data);

    if (personaGuardada) {
      await req.supabase.from('otras_cartas').update({ sinastria_cache: respuesta.data }).eq('id', personaGuardada.id);
    }

    res.json({ reporte: respuesta.data, desde_cache: false, debug_interpretaciones_traducidas: interpretacionesTraducidas });
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
app.post('/otras-cartas/:id/resumen', requireLogin, rutaSinDuplicados('/otras-cartas/:id/resumen', async (req, res) => {
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
}));

// RUTA: Generar la carta visual (rueda) de una persona guardada
app.post('/otras-cartas/:id/visual', requireLogin, rutaSinDuplicados('/otras-cartas/:id/visual', async (req, res) => {
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
}));

// RUTA: Guardar y calcular la carta de otra persona (familia, pareja, amigas — hasta 8)
app.post('/otras-cartas', requireLogin, async (req, res) => {
  try {
    const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo, latitud, longitud } = req.body;
    if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
      return res.status(400).json({ error: 'Faltan datos de la persona.' });
    }

    const { count } = await req.supabase.from('otras_cartas').select('*', { count: 'exact', head: true }).eq('user_id', req.userId);
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

    const { data: anterior, error: errorAnterior } = await req.supabase
      .from('otras_cartas').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (errorAnterior) return res.status(400).json({ error:errorAnterior.message });
    if (!anterior) return res.status(404).json({ error:'No se encontró esa carta.' });
    const numero = v => v == null || v === '' ? null : Number(v);
    const cambioNatal = [
      [anterior.fecha_nacimiento, fecha_nacimiento],
      [String(anterior.hora_nacimiento || '').slice(0,5), String(hora_nacimiento || '').slice(0,5)],
      [anterior.ciudad_nacimiento, ciudad_nacimiento],
      [anterior.pais_codigo, pais_codigo],
      [numero(anterior.latitud), numero(latitud ?? anterior.latitud)],
      [numero(anterior.longitud), numero(longitud ?? anterior.longitud)]
    ].some(([antes, despues]) => String(antes ?? '') !== String(despues ?? ''));
    if (!cambioNatal) {
      const { data, error } = await req.supabase.from('otras_cartas').update({ nombre })
        .eq('id', req.params.id).eq('user_id', req.userId).select().single();
      if (error) return res.status(400).json({ error:error.message });
      return res.json({ mensaje:'Carta actualizada', carta:data, cambio_natal:false });
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
  const { data, error } = await req.supabase
    .from('otras_cartas')
    .select('id, nombre, fecha_nacimiento, ciudad_nacimiento, created_at')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ cartas:data || [] });
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


const NOMBRES_PLANETAS_MES = { Sun:'Sol', Moon:'Luna', Mercury:'Mercurio', Venus:'Venus', Mars:'Marte', Jupiter:'Júpiter', Saturn:'Saturno', Uranus:'Urano', Neptune:'Neptuno', Pluto:'Plutón' };
const SIGNOS_MES_ES = { Ari:'Aries', Tau:'Tauro', Gem:'Géminis', Can:'Cáncer', Leo:'Leo', Vir:'Virgo', Lib:'Libra', Sco:'Escorpio', Sag:'Sagitario', Cap:'Capricornio', Aqu:'Acuario', Pis:'Piscis', Aries:'Aries', Taurus:'Tauro', Gemini:'Géminis', Cancer:'Cáncer', Virgo:'Virgo', Libra:'Libra', Scorpio:'Escorpio', Sagittarius:'Sagitario', Capricorn:'Capricornio', Aquarius:'Acuario', Pisces:'Piscis' };

function fechaEventoMes(valor, tz) {
  if (valor && typeof valor === 'object' && valor.year && valor.month && valor.day) {
    return { fecha: `${valor.year}-${String(valor.month).padStart(2,'0')}-${String(valor.day).padStart(2,'0')}`, hora:null, year:Number(valor.year), month:Number(valor.month) };
  }
  if (typeof valor !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return { fecha:valor, hora:null, year:Number(valor.slice(0,4)), month:Number(valor.slice(5,7)) };
  // El campo datetime_utc representa UTC incluso si el proveedor omite la Z.
  const instante = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(valor) ? valor : valor + 'Z');
  if (isNaN(instante)) return null;
  const p = partesEnZona(tz, instante);
  return { fecha:`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`, hora:`${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`, year:p.year, month:p.month };
}

function normalizarEventosGeneralesMes(payload, anio, mes, tz) {
  const eventos = payload?.data?.events || payload?.events;
  if (!Array.isArray(eventos)) throw new Error('La consulta mensual no incluyó su lista de eventos.');
  const salida = [];
  for (const original of eventos) {
    const e = { ...original, ...(original.details || {}) };
    const fecha = fechaEventoMes(e.datetime_utc || e.datetime || e.date, tz);
    if (!fecha) throw new Error('Un evento mensual llegó sin una fecha válida.');
    if (fecha.year !== anio || fecha.month !== mes) continue;
    const tipo = e.event_type || e.type;
    const planetaRaw = e.body || e.planet;
    const planeta = NOMBRES_PLANETAS_MES[planetaRaw] || planetaRaw;
    const signoRaw = e.to_sign || e.moon_sign || e.sign;
    const signo = SIGNOS_MES_ES[signoRaw] || signoRaw;
    let titulo, texto;
    if (tipo === 'sign_ingress') {
      if (!planeta || !signo) throw new Error('Un ingreso llegó sin planeta o signo.');
      if (planetaRaw === 'Moon') continue;
      titulo = `${planeta} entra en ${signo}`;
      texto = `Comienza el paso de ${planeta} por ${signo}. Es un movimiento del cielo compartido por todos; su efecto personal depende de la casa y los aspectos que active en tu carta.`;
    } else if (tipo === 'station') {
      if (!planeta) throw new Error('Una estación llegó sin planeta.');
      const direccion = String(e.station_kind || e.station_type || e.direction || e.motion || e.to_motion || '').toLowerCase();
      const retro = /retro/.test(direccion) || e.is_retrograde === true;
      const directo = /direct/.test(direccion) || e.is_retrograde === false;
      titulo = retro ? `${planeta} comienza su retrogradación` : directo ? `${planeta} retoma su movimiento directo` : `${planeta}: cambio de movimiento`;
      texto = retro ? `Empieza la fase retrógrada de ${planeta}: un período asociado a revisar y retomar sus temas.` : directo ? `${planeta} termina su fase retrógrada y vuelve al movimiento directo.` : 'El planeta cambia entre movimiento directo y retrógrado. Consulta el detalle de tu carta para entender qué temas activa.';
    } else if (tipo === 'lunation') {
      const fase = String(e.phase || e.lunation_phase || '').toLowerCase().replace(/[ -]/g,'_');
      const fases = { new:'Luna nueva', new_moon:'Luna nueva', full:'Luna llena', full_moon:'Luna llena', first_quarter:'Cuarto creciente', last_quarter:'Cuarto menguante' };
      titulo = fases[fase] || 'Lunación';
      if (signo) titulo += ` en ${signo}`;
      texto = /new/.test(fase) ? 'Inicio de un ciclo lunar. Observa qué tema quieres empezar a trabajar.' : /full/.test(fase) ? 'Culminación del ciclo lunar. Observa qué se hace visible y qué necesita un ajuste.' : 'Un punto de cambio dentro del ciclo lunar.';
    } else if (tipo === 'solar_eclipse' || tipo === 'lunar_eclipse') {
      titulo = tipo === 'solar_eclipse' ? 'Eclipse solar' : 'Eclipse lunar';
      if (signo) titulo += ` en ${signo}`;
      texto = 'Su relevancia personal depende de si toca tus planetas o ángulos natales. La fecha del evento no implica que sea visible desde tu ciudad.';
    } else continue;
    const temas = {
      Sun:{ foco:'Tu manera de mostrarte, dirigir y expresar lo que quieres.', accion:'Define una prioridad y da un paso concreto para hacerla visible.' },
      Mercury:{ foco:'Conversaciones, documentos, estudios y acuerdos.', accion:'Revisa lo pendiente y confirma fechas, mensajes y condiciones.' },
      Venus:{ foco:'Vínculos, disfrute, gastos y lo que valoras.', accion:'Observa qué recibes, qué das y qué acuerdos quieres revisar.' },
      Mars:{ foco:'Iniciativa, esfuerzo y la forma de manejar el desacuerdo.', accion:'Elige dónde poner tu energía y evita actuar solo por impulso.' },
      Jupiter:{ foco:'Aprendizaje, oportunidades y proyectos de expansión.', accion:'Compara las posibilidades con el tiempo y los recursos que tienes.' },
      Saturn:{ foco:'Compromisos, límites y responsabilidades.', accion:'Distingue qué puedes sostener y qué necesita una estructura más clara.' },
      Uranus:{ foco:'Cambios, independencia y formas distintas de hacer las cosas.', accion:'Prueba un ajuste concreto antes de cambiar todo de golpe.' },
      Neptune:{ foco:'Inspiración, expectativas y claridad de límites.', accion:'Distingue lo que deseas de lo que puedes confirmar con hechos.' },
      Pluto:{ foco:'Control, poder personal y procesos de cambio profundo.', accion:'Observa dónde necesitas recuperar autonomía o renegociar un límite.' },
    };
    let enfoque = temas[planetaRaw]?.foco || '';
    let accion = temas[planetaRaw]?.accion || '';
    if (tipo === 'lunation') {
      enfoque = /new/.test(String(e.phase || '')) ? 'Un tema que quieres empezar a cultivar.' : 'Un proceso que necesita balance, claridad o cierre.';
      accion = /new/.test(String(e.phase || '')) ? 'Escribe una intención y una acción pequeña para acompañarla.' : 'Revisa lo que ocurrió durante el ciclo y elige qué mantener o ajustar.';
    } else if (tipo === 'solar_eclipse' || tipo === 'lunar_eclipse') {
      enfoque = 'Los temas de la casa y los puntos natales que contacte el eclipse.';
      accion = 'Consulta sus contactos con tu carta antes de sacar conclusiones personales.';
    }
    const grado = tipo === 'lunation' ? e.moon_degree : typeof e.longitude === 'number' ? e.longitude % 30 : e.degree;
    const posicion = signo && typeof grado === 'number' ? `${signo} ${Math.floor(grado)}°${String(Math.floor((grado % 1) * 60)).padStart(2,'0')}′` : signo || '';
    salida.push({ tipo, titulo, texto, enfoque, accion, posicion, fecha:fecha.fecha, hora:fecha.hora });
  }
  return salida.sort((a,b) => (a.fecha + (a.hora || '')).localeCompare(b.fecha + (b.hora || '')));
}

// Resumen mensual independiente del calendario de días propicios.
// Los eventos globales se comparten; los tránsitos conservan el cálculo natal existente.
app.post('/mes-astrologico', requireLogin, rutaSinDuplicados('/mes-astrologico', async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error:'Primero guarda tus datos de nacimiento.' });
    const tz = zonaHorariaDesdeReq(req);
    const actual = partesEnZona(tz);
    const anio = actual.year;
    const mes = actual.month;
    if (!Number.isInteger(anio) || anio < 1900 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) return res.status(400).json({ error:'Elige un mes y un año válidos.' });
    const dias = new Date(Date.UTC(anio,mes,0)).getUTCDate();
    const refrescar = req.body?.forzar_recalculo === true;
    const globalKey = claveAhorro('eventos-mensuales-v2', anio, mes);
    const personalKey = claveAhorro(req.userId, 'transitos-mensuales-v2', anio, mes, birthDataDesdePerfil(perfil));
    async function consultarGeneral() {
      return cacheCieloPublico(globalKey, TTL.CALENDARIO_LUNAR, async () => {
      const desde = new Date(Date.UTC(anio,mes-1,0)).toISOString().slice(0,10);
      const hasta = new Date(Date.UTC(anio,mes,2)).toISOString().slice(0,10);
      const r = await astrologyApi.post('/mundane/events/search', {
        date_from:desde, date_to:hasta,
        event_types:['sign_ingress','station','lunation','solar_eclipse','lunar_eclipse'],
        bodies:['Sun','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'],
      });
      // Validar antes de guardar: una respuesta incompleta nunca se convierte en "sin eventos".
      normalizarEventosGeneralesMes(r.data, anio, mes, tz);
      return r.data;
      }, refrescar);
    }
    async function consultarPersonal() {
      return consultaUnica(personalKey, async () => {
      const guardado = cacheGet(personalKey);
      if (guardado && !refrescar) return guardado;
      const r = await astrologyApi.post('/analysis/natal-transit-report', {
        subject:birthDataDesdePerfil(perfil),
        transit_time:{ date_range:{ start_date:{year:anio,month:mes,day:1},end_date:{year:anio,month:mes,day:dias} } },
        orb:2, report_options:{tradition:'psychological',language:'es'},
      });
      const eventos = r.data?.data?.events || r.data?.events;
      if (!Array.isArray(eventos)) throw new Error('La consulta personal no incluyó su lista de tránsitos.');
      cacheSet(personalKey,eventos,TTL.CALENDARIO_LUNAR);
      return eventos;
      });
    }
    const [general, personal] = await Promise.allSettled([consultarGeneral(), consultarPersonal()]);
    const eventosGenerales = general.status === 'fulfilled' ? normalizarEventosGeneralesMes(general.value,anio,mes,tz) : [];
    const nombreAspecto = { conjunction:'conjunción',sextile:'sextil',square:'cuadratura',trine:'trígono',opposition:'oposición' };
    const eventosPersonales = personal.status === 'fulfilled' ? personal.value.flatMap(e => {
      const fecha = fechaEventoMes(e.exact_time || e.exact_date || e.datetime || e.timestamp || e.date || e.start_date, tz);
      if (!fecha || fecha.year !== anio || fecha.month !== mes) return [];
      return [{
        fecha:fecha.fecha, hora:fecha.hora, planeta_transito:NOMBRES_PLANETAS_MES[e.transiting_planet] || e.transiting_planet,
        punto_natal:NOMBRES_PLANETAS_MES[e.stationed_planet || e.natal_planet] || e.stationed_planet || e.natal_planet,
        aspecto:nombreAspecto[String(e.aspect_type || '').toLowerCase()] || e.aspect_type,
        area:e.area || e.life_area || '', interpretacion:e.interpretation || e.description || '',
        orbe:typeof e.orb === 'number' ? e.orb : null,
      }];
    }) : [];
    if (general.status === 'rejected') console.error('Eventos mensuales:', general.reason?.response?.status || general.reason?.message);
    if (personal.status === 'rejected') console.error('Tránsitos mensuales:', personal.reason?.response?.status || personal.reason?.message);
    res.json({ mes,anio,contexto_tiempo:{timezone:tz},mes_astrologico:{
      eventos_generales:eventosGenerales, eventos_destacados:eventosPersonales,
      estado_general:general.status === 'fulfilled' ? 'disponible' : 'no_disponible',
      estado_personal:personal.status === 'fulfilled' ? 'disponible' : 'no_disponible',
    } });
  } catch (err) {
    console.error('Resumen mensual:', err.message);
    res.status(500).json({error:'No se pudo cargar tu mes. Vuelve a intentarlo.'});
  }
}));


// RUTA: Calendario lunar del mes — mejores días específicos por actividad
app.post('/calendario-lunar', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const tz = zonaHorariaDesdeReq(req);
    const local = partesEnZona(tz);
    const anio = parseInt(req.body?.anio) || local.year;
    const mes = parseInt(req.body?.mes) || local.month;
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

    // 1) EFEMÉRIDES LUNARES GLOBALES DEL MES
    // No dependen de la carta natal: una sola serie mensual sirve a todos los usuarios.
    const cacheLunaMesKey = cacheHash('calendario-lunar-global-v2', `${anio}-${mes}`);
    let resultados = cacheGet(cacheLunaMesKey);

    if (!resultados) {
      const dias = Array.from({ length: diasEnMes }, (_, i) => i + 1);
      resultados = await Promise.all(dias.map(async (dia) => {
        try {
          const r = await astrologyApi.post('/analysis/lunar-analysis', {
            datetime_location: {
              year: anio, month: mes, day: dia, hour: 12, minute: 0, second: 0,
              city: 'Greenwich', country_code: 'GB',
            },
            report_options: { language: 'es' },
          });
          const m = r.data?.data?.lunar_metrics;
          return {
            dia,
            signo: m?.moon_sign || null,
            fase: m?.moon_phase || null,
            iluminacion: typeof m?.moon_illumination === 'number' ? Math.round(m.moon_illumination) : null,
          };
        } catch (e) {
          return { dia, signo: null, fase: null, iluminacion: null };
        }
      }));
      // Un mes lunar pasado/futuro no cambia: 7 días en memoria reduce llamadas repetidas.
      cacheSet(cacheLunaMesKey, resultados, 7 * 24 * 60 * 60 * 1000);
    }

    // 2) DATOS PERSONALES DEL MES
    // Solo esto depende de la carta natal de la usuaria.
    const cachePersonalKey = cacheHash(req.userId, 'calendario-personal-v2', `${anio}-${mes}`);
    const cachedPersonal = cacheGet(cachePersonalKey);
    if (cachedPersonal) {
      return res.json({
        ...cachedPersonal,
        detalle_dias: resultados,
        contexto_tiempo: { timezone: local.timezone },
      });
    }

    const transitosMes = perfil ? await astrologyApi.post('/analysis/natal-transit-report', {
      subject: birthDataDesdePerfil(perfil),
      transit_time: {
        date_range: {
          start_date: { year: anio, month: mes, day: 1 },
          end_date: { year: anio, month: mes, day: diasEnMes },
        },
      },
      orb: 2,
      report_options: { tradition: 'psychological', language: 'es' },
    }).catch(e => {
      console.error('natal-transit-report (calendario) falló:', e?.response?.data || e.message);
      return { _error_debug: e?.response?.data || e.message };
    }) : null;

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

    // Ya no inferimos "Mercurio retrógrado durante todo el mes" desde una sola fecha.
    // Se deja null hasta implementar el rango exacto mensual, evitando mostrar información falsa.
    const mercurioRetrogrado = null;

    // ---- Procesar días de poder personal ----
    const PLANETAS_BENEFICOS = ['Sun', 'Venus', 'Jupiter'];
    const NOMBRE_ES = {
      Sun: 'Sol', Moon: 'Luna', Mercury: 'Mercurio', Venus: 'Venus', Mars: 'Marte',
      Jupiter: 'Júpiter', Saturn: 'Saturno', Uranus: 'Urano', Neptune: 'Neptuno', Pluto: 'Plutón',
      Medium_Coeli: 'Medio Cielo', Midheaven: 'Medio Cielo', MC: 'Medio Cielo',
      Ascendant: 'Ascendente', Descendant: 'Descendente', Imum_Coeli: 'Fondo de Cielo',
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

    const respuestaPersonal = {
      mes, anio, calendario, mercurio_retrogrado: mercurioRetrogrado,
      dias_poder_personal: diasPoderPersonal,
      dias_poder_personal_error: diasPoderError,
      dias_poder_personal_diagnostico: diasPoderDiagnostico,
    };
    cacheSet(cachePersonalKey, respuestaPersonal, TTL.CALENDARIO_LUNAR);
    res.json({
      ...respuestaPersonal,
      detalle_dias: resultados,
      contexto_tiempo: { timezone: local.timezone },
    });
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

    const respuesta = await astrologyApi.post('/numerology/core-numbers', {
      subject: datosSubject,
      language: 'es',
    });

    await traducirInterpretacionesEnObjeto(respuesta.data);
    const r = { numerologia: respuesta.data };
    cacheSet(cacheKey, r, TTL.NUMEROLOGIA);
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
    await traducirInterpretacionesEnObjeto(respuestaEnergia);
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

// RUTA: Tránsitos personalizados (próximos 30 días)
app.post('/transitos-personales', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date();
    const bloque2h = Math.floor(Date.now() / TTL.TRANSITOS_PERSONALES);
    const cacheKey = cacheHash(req.userId, 'transitos-v2', bloque2h);
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const desde5dias = new Date(hoy.getTime() - 5 * 24 * 60 * 60 * 1000);
    const en7dias = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000);

    const respuesta = await astrologyApi.post('/analysis/natal-transit-report', {
      subject: birthDataDesdePerfil(perfil),
      transit_time: {
        date_range: {
          start_date: { year: desde5dias.getUTCFullYear(), month: desde5dias.getUTCMonth() + 1, day: desde5dias.getUTCDate() },
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

    // Ordenar cronológicamente y quedarnos solo con hoy en adelante (los 7 próximos días)
    const eventosCrudos = respuesta.data?.data?.events || respuesta.data?.events || [];
    const obtenerFecha = (ev) => ev.date_local || ev.date || ev.exact_date || ev.transit_date || null;
    const hoyStr = hoy.toISOString().slice(0, 10);
    const en7diasStr = en7dias.toISOString().slice(0, 10);
    const eventosOrdenados = eventosCrudos
      .filter(ev => {
        const f = obtenerFecha(ev);
        return f && f.slice(0, 10) >= hoyStr && f.slice(0, 10) <= en7diasStr;
      })
      .sort((a, b) => {
        const fa = obtenerFecha(a), fb = obtenerFecha(b);
        if (!fa || !fb) return 0;
        return new Date(fa) - new Date(fb);
      });

    // Inyectar los eventos ordenados de vuelta en la respuesta
    const datosLimpios = { ...respuesta.data };
    if (datosLimpios?.data?.events) datosLimpios.data.events = eventosOrdenados;
    else if (datosLimpios?.events) datosLimpios.events = eventosOrdenados;

    const respuestaTransitos = { transitos: datosLimpios };
    await traducirInterpretacionesEnObjeto(respuestaTransitos);
    cacheSet(cacheKey, respuestaTransitos, TTL.TRANSITOS_PERSONALES);
    res.json(respuestaTransitos);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudieron calcular los tránsitos.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// Las tiendas no deben abrir pagos mientras falte la validación de comprobantes.
// Solo activar disponibilidad cuando estén implementadas y probadas compras,
// renovaciones, vencimiento, restauración y vinculación a la cuenta.
app.get('/suscripcion/configuracion-nativa', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ disponible:false, plataformas:[] });
});

app.post('/suscripcion/iniciar', requireLogin, async (req, res) => {
  try {
    const PRECIOS_POR_PLAN = {
      mensual: process.env.STRIPE_PRICE_ID,
      semestral: process.env.STRIPE_PRICE_ID_SEMESTRAL,
      anual: process.env.STRIPE_PRICE_ID_ANUAL,
    };
    const plan = req.body?.plan || 'mensual';
    if (!['mensual','semestral','anual'].includes(plan)) return res.status(400).json({ error:'Elige un plan válido.' });
    const priceId = PRECIOS_POR_PLAN[plan];
    if (!priceId) return res.status(400).json({ error: `Falta configurar el precio de Stripe para el plan "${plan}".` });

    // Validar el precio real del proveedor, no solo el texto mostrado en pantalla.
    const esperado = {
      mensual:{ importe:499, intervalo:'month', cantidad:1 },
      semestral:{ importe:2599, intervalo:'month', cantidad:6 },
      anual:{ importe:4599, intervalo:'year', cantidad:1 },
    }[plan];
    const precio = await stripe.prices.retrieve(priceId);
    const servicioPruebas = /pruebas/i.test(req.get('host') || '') || process.env.BILLING_ENV !== 'production';
    if (servicioPruebas && precio.livemode) return res.status(503).json({ error:'Los cobros reales están deshabilitados en pruebas.' });
    if (!precio.active || precio.currency !== 'usd' || precio.unit_amount !== esperado.importe ||
        precio.recurring?.interval !== esperado.intervalo || precio.recurring?.interval_count !== esperado.cantidad ||
        precio.recurring?.usage_type !== 'licensed' || precio.billing_scheme !== 'per_unit' ||
        precio.transform_quantity) {
      return res.status(503).json({ error:'El precio del plan necesita revisión antes de iniciar el pago.' });
    }

    // Buscamos si ya existe un customer_id guardado; si no, creamos uno en Stripe
    const { data: subExistente, error: errorSub } = await req.supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (errorSub) throw new Error('No se pudo consultar la suscripción.');
    let customerId = subExistente?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.userEmail });
      customerId = customer.id;
      const { error: errorGuardarSub } = await supabase.from('subscriptions').upsert({
        user_id: req.userId,
        stripe_customer_id: customerId,
        estado: 'pendiente',
      }, { onConflict: 'user_id' });
      if (errorGuardarSub) throw new Error('No se pudo guardar la suscripción.');
    }

    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 3,
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
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(401).json({ error: 'No autorizado.' });
    // Verificar que es admin
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

  if (!webhookSecret) return res.status(503).json({ error:'La confirmación de pagos aún no está configurada.' });
  if (!sig) return res.status(400).json({ error:'Falta la firma del proveedor.' });
  let evento;
  try {
    evento = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const sb = supabase; // cliente admin para webhooks
  const guardarPago = async operacion => {
    const resultado = await operacion;
    if (resultado.error) throw new Error('No se pudo guardar la confirmación del pago.');
    return resultado;
  };

  try {
    switch (evento.type) {
      case 'checkout.session.completed': {
        const session = evento.data.object;
        const userId = session.metadata?.user_id;
        if (userId && session.subscription) {
          await guardarPago(sb.from('subscriptions').upsert({
            user_id: userId,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            estado: 'activa',
          }, { onConflict: 'user_id' }));
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = evento.data.object;
        const { data: perfil } = await guardarPago(sb.from('subscriptions').select('user_id').eq('stripe_subscription_id', sub.id).maybeSingle());
        if (perfil) {
          const estado = (sub.status === 'active' || sub.status === 'trialing') ? 'activa' : sub.status === 'past_due' ? 'vencida' : 'cancelada';
          await guardarPago(sb.from('subscriptions').update({ estado }).eq('stripe_subscription_id', sub.id));
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = evento.data.object;
        await guardarPago(sb.from('subscriptions').update({ estado: 'cancelada' }).eq('stripe_subscription_id', sub.id));
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = evento.data.object;
        if (invoice.subscription) {
          await guardarPago(sb.from('subscriptions').update({ estado: 'vencida' }).eq('stripe_subscription_id', invoice.subscription));
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    return res.status(500).json({ error:'No se pudo guardar el pago. El proveedor debe reintentar.' });
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
