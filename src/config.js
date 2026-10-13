// Configuración central. Todo secreto vive en variables de entorno del servidor.
try { process.loadEnvFile?.('.env'); } catch { /* sin .env: se usan las variables del entorno */ }

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/rockola',
  // URL pública (https) con la que se arma el QR. Sin ella se usa el host de la petición.
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  isProd: env.NODE_ENV === 'production',

  youtube: {
    apiKey: env.YOUTUBE_API_KEY || '',
    // Interruptor explícito: YouTube no se ofrece a los clientes hasta confirmar por escrito el permiso de uso comercial.
    enabled: env.YOUTUBE_HABILITADO === 'si',
    regionCode: env.YOUTUBE_REGION || 'CO',
    dailyQuota: int(env.YOUTUBE_CUOTA_DIARIA, 10000),
    // Unidades que se reservan para validar videos (videos.list) aunque se agoten las búsquedas.
    reserveUnits: int(env.YOUTUBE_RESERVA_UNIDADES, 500),
    searchCacheHours: int(env.YOUTUBE_CACHE_BUSQUEDA_HORAS, 24),
  },

  adminSessionHours: int(env.ADMIN_SESION_HORAS, 12),
  phoneRetentionDays: int(env.RETENCION_TELEFONO_DIAS, 30),
  leaderLeaseSec: int(env.LIDER_VIGENCIA_SEG, 15),
  maxConsecutiveFailures: int(env.MAX_FALLOS_SEGUIDOS, 3),
};

// Valores iniciales de cada sala; el administrador los edita desde el panel.
export const DEFAULT_SETTINGS = {
  max_pendientes: 3,            // canciones pendientes por persona
  intervalo_seg: 30,            // tiempo mínimo entre solicitudes de una persona
  duracion_max_seg: 480,        // 8 minutos
  permitir_duplicados: false,   // misma canción dos veces en la fila
  repeticion_min: 60,           // minutos antes de volver a pedir una canción ya reproducida
  aprobacion_manual: false,
  limite_fila: 50,
  excluir_en_vivo: true,
  telefono: 'no',               // 'no' | 'opcional'
  exigir_codigo: false,         // código visible en el local
  crossfade_seg: 0,             // solo aplica al catálogo autorizado
};

export function mergeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

const SETTING_RULES = {
  max_pendientes: [1, 20], intervalo_seg: [0, 3600], duracion_max_seg: [30, 7200],
  repeticion_min: [0, 1440], limite_fila: [1, 500], crossfade_seg: [0, 12],
};

/** Valida y normaliza cambios de configuración; ignora claves desconocidas. */
export function sanitizeSettings(input) {
  const out = {};
  for (const [k, [min, max]] of Object.entries(SETTING_RULES)) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Valor inválido para ${k} (${min}–${max})`);
    out[k] = n;
  }
  for (const k of ['permitir_duplicados', 'aprobacion_manual', 'excluir_en_vivo', 'exigir_codigo']) {
    if (input[k] !== undefined) out[k] = Boolean(input[k]);
  }
  if (input.telefono !== undefined) {
    if (!['no', 'opcional'].includes(input.telefono)) throw new Error('Valor inválido para telefono');
    out.telefono = input.telefono;
  }
  return out;
}
