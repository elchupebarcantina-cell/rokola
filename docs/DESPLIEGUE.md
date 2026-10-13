# Despliegue

Una sola instalación sirve a todas las sedes. Los videos nunca pasan por este servidor (van del proveedor al televisor), así que el consumo es bajo.

## 1. Railway

1. Sube el código a un repositorio privado de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** y elige el repositorio. `railway.json` ya define el comando de arranque y la verificación de salud (`/salud`).
3. En el mismo proyecto: **New → Database → PostgreSQL**.
4. En el servicio de la aplicación, pestaña **Variables**:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `PUBLIC_BASE_URL` | La URL pública con https (paso 5) |
| `NODE_ENV` | `production` |
| `YOUTUBE_HABILITADO` | `no` |

5. **Settings → Networking → Generate Domain** (o conecta un dominio propio, por ejemplo `rockola.elchupe.co`). Copia esa URL en `PUBLIC_BASE_URL`: con ella se arma el QR.
6. Crea el administrador general: agrega temporalmente las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 10 caracteres) y deja que el servicio se reinicie. En ese arranque se crean el administrador, las sedes Calle 72, Bachué y Acacías y el catálogo DEMO. Luego **borra `ADMIN_PASSWORD`** de las variables; la contraseña se cambia desde Panel → Usuarios.
7. Entra a `https://<tu-dominio>/admin`.

Notas:

- Las migraciones se aplican solas en cada arranque. Actualizar la aplicación no toca los datos: viven en el servicio de PostgreSQL.
- **Deja una sola réplica.** El tiempo real ya soporta varias, pero el limitador de abuso guarda sus contadores en memoria (ver [LIMITACIONES.md](LIMITACIONES.md)).
- HTTPS es obligatorio en producción: las cookies de sesión se marcan `Secure` cuando la petición llega por HTTPS, y los celulares con datos móviles solo llegan por la URL pública.

## 2. Copias de seguridad

- Activa los respaldos programados del servicio PostgreSQL en Railway (pestaña **Backups**; disponibilidad según el plan).
- Además, respaldo propio con `pg_dump`:

```bash
DATABASE_URL='postgres://…' npm run respaldo      # deja respaldos/rockola-AAAA-MM-DD-HHMM.dump
pg_restore --clean --no-owner -d "$DATABASE_URL" respaldos/rockola-….dump   # restaurar
```

Programa ese comando a diario en un equipo tuyo y guarda la carpeta `respaldos/` fuera del servidor. Haz una restauración de prueba antes de confiar en él.

## 3. Google Cloud y la API de YouTube (solo si se va a usar YouTube)

Antes de este paso lee [LEGAL-Y-COSTOS.md](LEGAL-Y-COSTOS.md): tener clave no autoriza el uso en el bar.

1. En <https://console.cloud.google.com/> crea **un proyecto exclusivo para la rockola**. La política de YouTube exige un solo proyecto por aplicación y prohíbe repartir el consumo entre varios.
2. **APIs y servicios → Biblioteca → YouTube Data API v3 → Habilitar.**
3. **APIs y servicios → Credenciales → Crear credenciales → Clave de API.**
4. Restringe la clave: en *Restricciones de API* elige solo **YouTube Data API v3**. La clave se usa desde el servidor, no desde el navegador, así que no sirve restringirla por sitio web.
5. Guarda la clave en la variable `YOUTUBE_API_KEY` del servidor. No va en el código ni en el repositorio.
6. El reproductor del televisor (IFrame Player API) no usa clave. Se identifica con el dominio de la página, por eso el servidor envía `Referrer-Policy: strict-origin-when-cross-origin` y hay que usar siempre el mismo dominio https.
7. Solo cuando exista el permiso escrito: `YOUTUBE_HABILITADO=si`, y en el panel, con la sesión cerrada, **Configuración → Proveedor de contenido → YouTube**.

### Cuota

- 10.000 unidades diarias por proyecto, compartidas por todas las sedes. Una búsqueda cuesta 100 unidades; validar un video, 1. Son unas 95 búsquedas reales al día, porque el sistema reserva 500 unidades para validar videos (`YOUTUBE_RESERVA_UNIDADES`).
- El sistema ahorra cuota así: espera medio segundo antes de buscar mientras la persona escribe, exige mínimo 3 letras, guarda cada búsqueda 24 horas, pagina solo cuando alguien pulsa «Ver más resultados» y ofrece sugerencias que no gastan cuota.
- La cuota se reinicia a medianoche, hora del Pacífico (2 o 3 a. m. en Colombia).
- **Más cuota no se compra.** Se solicita con el formulario de auditoría de cumplimiento de YouTube API Services, describiendo el caso de uso; YouTube revisa la aplicación y decide. La cuota concedida solo puede usarse para el caso aprobado. Formulario: <https://support.google.com/youtube/contact/yt_api_form>
- El consumo del día y los últimos 14 días se ven en **Panel → Consumo de API**.

## 4. Agregar contenido al catálogo autorizado

**Panel → Sedes y salas → Catálogo autorizado → Agregar contenido.** Cada ítem es un título, una URL https a un archivo `mp4`, `webm` o `mp3`, su duración y el origen del derecho de uso. El archivo debe estar en un alojamiento que permita reproducirlo desde el dominio de la rockola (por ejemplo un bucket con acceso público de lectura). El sistema no sube ni almacena archivos.

Las pistas DEMO se pueden dejar para pruebas; se identifican con la etiqueta DEMO en todas las pantallas.
