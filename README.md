# Rockola El Chupe

Videorrockola colaborativa para bares: el cliente escanea un QR, busca una canción desde su celular y la agrega a una fila que suena sola en el televisor. Una instalación atiende todas las sedes; cada sala tiene su fila, su configuración y su sesión.

| Pantalla | Dirección | Quién la usa |
|---|---|---|
| Cliente | `/s/<código de la sesión>` (lo abre el QR) | Clientes, desde el celular, sin instalar nada |
| Televisor | `/tv` | El equipo conectado al televisor |
| Panel | `/admin` | Administrador general, administrador de sede, operador de sala |

## Estado real del proyecto

- **Probado de punta a punta** con el catálogo autorizado en modo DEMO (pistas generadas por el propio sistema): 29 pruebas automáticas contra PostgreSQL real y 17 pasos en navegadores reales. Detalle en [docs/PRUEBAS.md](docs/PRUEBAS.md).
- **YouTube está implementado pero no probado con el servicio real** (no había credenciales ni acceso a YouTube en el entorno de desarrollo) y **viene apagado**. No debe encenderse en un bar sin el permiso escrito de YouTube. Ver [docs/LEGAL-Y-COSTOS.md](docs/LEGAL-Y-COSTOS.md).
- Lo que falta para operar legalmente está en la lista de [autorizaciones pendientes](docs/LEGAL-Y-COSTOS.md#autorizaciones-pendientes).

## Arquitectura

```
Celulares ──HTTPS──┐
Televisor ──HTTPS──┼──► Node.js + Express ──► PostgreSQL
Panel     ──HTTPS──┘        │   ▲                 │
                            │   └── LISTEN/NOTIFY ┘  (cada cambio avisa a todas las pantallas)
                            └──► Proveedor de contenido (catálogo autorizado | YouTube | el que se agregue)
```

- **Node.js 22 + Express + PostgreSQL**, sin paso de compilación. Es el mismo stack y el mismo despliegue (Railway) del POS de El Chupe, y la rockola necesita conexiones abiertas permanentes para el tiempo real, que en un servidor Node tradicional salen directas. Por eso no se usó Next.js.
- **Tiempo real**: Server-Sent Events hacia los navegadores y `LISTEN/NOTIFY` de PostgreSQL por dentro. Si el canal se cae, cada pantalla además consulta cada 10–15 s.
- **La fila la ordena el servidor**. Toda operación sobre la fila de una sala pasa por un candado transaccional de esa sala (`withRoomLock` en `src/db.js`); el turno (`seq`) se asigna ahí. La base tiene además índices únicos que hacen imposible, aunque el código fallara, tener dos canciones sonando a la vez en una sesión, dos sesiones abiertas en una sala o dos solicitudes con el mismo turno.
- **Repertorio**: listas de YouTube importadas a 1 unidad por cada 50 videos; la búsqueda de los clientes consulta primero ahí sin gastar cuota (`src/services/repertorio.js`).
- **Proveedores intercambiables** (`src/providers/`): cada proveedor implementa `search`, `getMedia` y `status`, y tiene su adaptador de reproducción en `public/tv/players.js`. Agregar un catálogo comercial es crear esos dos archivos; nada más cambia.

```
migrations/        Esquema SQL (se aplica solo al arrancar)
src/
  server.js        Arranque        app.js   Rutas, cabeceras de seguridad, errores
  config.js        Variables de entorno y valores iniciales de cada sala
  db.js            Conexión, transacciones, candado por sala, migraciones
  providers/       catalogo.js · youtube.js · index.js (contrato)
  services/        queue.js (fila) · playback.js (avance) · sessions.js · snapshot.js · retention.js
  routes/          public.js (QR) · tv.js (pantalla) · admin.js (panel)
  lib/             auth.js (roles, CSRF) · realtime.js (SSE) · util.js
public/            cliente/ · tv/ · admin/ · css/ · fonts/ · img/
test/              Pruebas automáticas          scripts/   e2e.mjs · respaldo.sh · migrar.mjs
docs/              Despliegue, televisor, guía del personal, pruebas, legal y costos, limitaciones
```

## Puesta en marcha local

Requisitos: Node.js 22 o superior y PostgreSQL 14 o superior.

```bash
npm install
cp .env.example .env            # ajusta DATABASE_URL; deja PUBLIC_BASE_URL vacío en local
createdb rockola
ADMIN_EMAIL=tu@correo.com ADMIN_PASSWORD='una-clave-larga' npm run seed
npm start                        # http://localhost:3000/admin
```

`npm run seed` crea el administrador general, las sedes Calle 72, Bachué y Acacías con una sala cada una, y 12 pistas DEMO. Se puede ejecutar varias veces sin duplicar nada.

Para probar con celulares en la misma red, usa la IP del computador (`http://192.168.x.x:3000`). Con datos móviles hace falta una URL pública: ver [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Arranca el servidor (aplica migraciones pendientes) |
| `npm run seed` | Crea administrador, sedes y catálogo DEMO |
| `npm test` | 29 pruebas automáticas (necesita una base de pruebas: `TEST_DATABASE_URL`) |
| `npm run e2e` | Prueba en navegadores reales contra un servidor en marcha |
| `npm run respaldo` | Copia de seguridad con `pg_dump` |

## Documentación

- [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) — Railway, dominio, Google Cloud, copias de seguridad
- [docs/TELEVISOR.md](docs/TELEVISOR.md) — conectar y preparar el equipo del televisor
- [docs/GUIA-PERSONAL.md](docs/GUIA-PERSONAL.md) — operación diaria, en una página
- [docs/PRUEBAS.md](docs/PRUEBAS.md) — resultados y verificaciones manuales pendientes
- [docs/LEGAL-Y-COSTOS.md](docs/LEGAL-Y-COSTOS.md) — viabilidad, autorizaciones pendientes, servicios y costos
- [docs/LIMITACIONES.md](docs/LIMITACIONES.md) — lo que el sistema no hace o no garantiza
