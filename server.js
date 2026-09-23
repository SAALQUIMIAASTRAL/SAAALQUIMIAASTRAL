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
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.json()(req, res, next);
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
  ENERGIA_DIA: 60 * 60 * 1000,           // 1 hr
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
    const prompt = `Traduce cada uno de estos textos de astrología al español de México/Latinoamérica, natural y con tono cálido y profesional (no traducción literal palabra por palabra, y sin modismos de España como "vosotros" o "vale"). Responde ÚNICAMENTE con un array JSON de strings, en el mismo orden, sin explicación ni markdown:\n\n${JSON.stringify(lista)}`;
    const controlador = new AbortController();
    const timeoutId = setTimeout(() => controlador.abort(), 25000);
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
  const TAMANO_BLOQUE = 25;
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
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ mensaje: 'Cuenta creada', usuario: data.user });
});

// ============================================================
// RUTA: Inicio de sesión
// ============================================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
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

  // Invalidar TODO lo que depende de los datos de nacimiento al editarlos —
  // si no, quedan resultados viejos calculados con la fecha/ciudad anterior.
  const hoy = new Date();
  const anioActual = hoy.getUTCFullYear();
  const mesActual = hoy.getUTCMonth() + 1;
  memoriaCache.delete(cacheHash('perfil', req.userId));
  memoriaCache.delete(cacheHash(req.userId, 'acg', 'propia'));
  memoriaCache.delete(cacheHash(req.userId, 'estrellas', 'propia'));
  memoriaCache.delete(cacheHash(req.userId, 'calendario-lunar', `${anioActual}-${mesActual}`));
  memoriaCache.delete(cacheHash(req.userId, 'home', hoyStr()));
  memoriaCache.delete(cacheHash(req.userId, 'numerologia', 'propia', hoyStr()));
  memoriaCache.delete(cacheHash(req.userId, 'energia', hoyStr()));
  memoriaCache.delete(cacheHash(req.userId, 'horoscopo', hoyStr()));
  memoriaCache.delete(cacheHash(req.userId, 'transitos', horaStr()));
  await req.supabase.from('natal_charts').delete().eq('user_id', req.userId);

  res.json({ mensaje: 'Perfil guardado', perfil: data });
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
});

app.post('/luna', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const ahora = new Date();
    const cacheKey = cacheHash(req.userId, horaStr())
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
      luna: luna ? { signo: luna.moon_sign, fase: luna.moon_phase, iluminacion: Math.round(luna.moon_illumination), dia_lunar: luna.moon_day } : null,
      dia_personal: diaPersonal,
      anio_personal: anioPersonal,
      transito_principal: transitoPrincipal,
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
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

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
    const anio = hoy.getUTCFullYear();
    const mes = hoy.getUTCMonth() + 1;
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

    // Caché por usuario + mes/año — este cálculo cuesta ~32 créditos de API, no debe repetirse en cada clic
    const cacheKey = cacheHash(req.userId, 'calendario-lunar', `${anio}-${mes}`);
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const dias = Array.from({ length: diasEnMes }, (_, i) => i + 1);

    const [resultados, chartHoy, transitosMes] = await Promise.all([
      Promise.all(dias.map(async (dia) => {
        try {
          const r = await astrologyApi.post('/analysis/lunar-analysis', {
            datetime_location: {
              year: anio, month: mes, day: dia, hour: 12, minute: 0, second: 0,
              city: perfil?.ciudad_nacimiento || 'Mexico City', country_code: perfil?.pais_codigo || 'MX',
            },
            report_options: { language: 'es' },
          });
          const m = r.data?.data?.lunar_metrics;
          return { dia, signo: m?.moon_sign, fase: m?.moon_phase };
        } catch (e) {
          return { dia, signo: null, fase: null };
        }
      })),
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

    const respuestaCalendario = {
      mes, anio, calendario, detalle_dias: resultados, mercurio_retrogrado: mercurioRetrogrado,
      dias_poder_personal: diasPoderPersonal,
      dias_poder_personal_error: diasPoderError,
      dias_poder_personal_diagnostico: diasPoderDiagnostico,
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
    const cacheKey = cacheHash(req.userId, 'transitos', horaStr());
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const en30dias = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000);

    const respuesta = await astrologyApi.post('/analysis/natal-transit-report', {
      subject: birthDataDesdePerfil(perfil),
      transit_time: {
        date_range: {
          start_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1, day: hoy.getUTCDate() },
          end_date: { year: en30dias.getUTCFullYear(), month: en30dias.getUTCMonth() + 1, day: en30dias.getUTCDate() },
        },
      },
      orb: 5,
      active_points: ['Sun', 'Moon', 'Mercury', 'Venus', 'Saturn', 'Pluto', 'Neptune', 'Uranus', 'Mean_Lilith', 'Chiron'],
      report_options: { tradition: 'psychological', language: 'es' },
    });

    // Ordenar cronológicamente por fecha (el API no garantiza el orden)
    const eventosCrudos = respuesta.data?.data?.events || respuesta.data?.events || [];
    const obtenerFecha = (ev) => ev.date_local || ev.date || ev.exact_date || ev.transit_date || null;
    const eventosOrdenados = [...eventosCrudos].sort((a, b) => {
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
      .select('stripe_customer_id')
      .eq('user_id', req.userId)
      .maybeSingle();

    let customerId = subExistente?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.userEmail });
      customerId = customer.id;
      await req.supabase.from('subscriptions').upsert({
        user_id: req.userId,
        stripe_customer_id: customerId,
        estado: 'pendiente',
      }, { onConflict: 'user_id' });
    }

    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
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
        if (userId && session.subscription) {
          await sb.from('subscriptions').upsert({
            user_id: userId,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            estado: 'activa',
          }, { onConflict: 'user_id' });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = evento.data.object;
        const { data: perfil } = await sb.from('subscriptions').select('user_id').eq('stripe_subscription_id', sub.id).maybeSingle();
        if (perfil) {
          const estado = (sub.status === 'active' || sub.status === 'trialing') ? 'activa' : sub.status === 'past_due' ? 'vencida' : 'cancelada';
          await sb.from('subscriptions').update({ estado }).eq('stripe_subscription_id', sub.id);
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
