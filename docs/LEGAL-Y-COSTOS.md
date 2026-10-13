# Viabilidad, autorizaciones y costos

Revisado el 13 de octubre de 2026 contra las fuentes oficiales enlazadas al final. Esto es un análisis técnico y documental, no un concepto jurídico: antes de operar con música de terceros conviene que lo valide un abogado de propiedad intelectual.

## Tres permisos distintos

Usar YouTube en un bar depende de tres cosas que no se reemplazan entre sí.

### 1. Acceso y cuota de la API — se resuelve

- La YouTube Data API es gratuita. Cada proyecto recibe 10.000 unidades diarias; una búsqueda (`search.list`) cuesta 100 y consultar un video (`videos.list`) cuesta 1.
- La cuota adicional no se vende. Se solicita con una auditoría de cumplimiento en la que se describe el caso de uso, y lo concedido solo puede usarse para ese caso.
- Las políticas de la API permiten usos comerciales de una aplicación (venderla, ponerle marca propia) y prohíben, entre otras cosas: cobrar por ver contenido en el reproductor, vender publicidad o patrocinios sobre el reproductor, poner elementos encima del reproductor, modificarlo, bloquear o alterar anuncios, separar audio y video, reproducir desde un reproductor oculto, guardar copias del contenido y conservar metadatos más de 30 días.

El sistema cumple esas reglas en su diseño: usa solo la Data API y el IFrame Player API, no superpone nada al reproductor, deja visibles controles y marca, no toca los anuncios, tiene un solo reproductor a la vista, guarda solo metadatos y los purga a los 30 días, muestra los enlaces a los Términos de YouTube y a la Política de Privacidad de Google, y no cobra por pedir canciones.

### 2. Permiso contractual de YouTube — bloqueante hoy

Los Términos del Servicio de YouTube (versión del 15 de diciembre de 2023, vigente) dicen que el contenido es para uso **personal, no comercial**, y entre las restricciones ponen este ejemplo literal: no se puede *proyectar videos públicamente ni transmitir música* desde el servicio, salvo autorización expresa del servicio o permiso previo por escrito de YouTube y, cuando aplique, de los titulares.

Consecuencias:

- Que la reproducción use el reproductor oficial y muestre anuncios **no** convierte en permitido el uso en un establecimiento.
- **YouTube Premium no lo autoriza**: es una suscripción personal sujeta a los mismos términos.
- **La clave de API y una ampliación de cuota tampoco**: regulan el acceso técnico, no el derecho a exhibir en público.
- La auditoría de cumplimiento obliga a declarar el caso de uso. Un caso que contradice los Términos puede ser rechazado, y YouTube puede suspender las credenciales.

Por eso YouTube viene apagado (`YOUTUBE_HABILITADO=no`) y el sistema no deja asignarlo a una sala mientras siga así.

### 3. Comunicación pública en Colombia — trámite propio, necesario con cualquier proveedor

- Poner música o videos musicales en un establecimiento abierto al público es comunicación pública y requiere autorización previa de los titulares (Ley 23 de 1982 y Decisión Andina 351).
- La **Organización Sayco Acinpro (OSA)** es la ventanilla de recaudo de Sayco (autores y compositores), Acinpro (intérpretes y productores fonográficos), Acodem y Pro Música. Según su sitio, licencia la comunicación de **música y videos musicales** de sus asociados en establecimientos. Tiene simulador de tarifas y oficina virtual.
- La licencia de la OSA cubre el repertorio que representa, no todo lo que existe. Para obras audiovisuales que no sean videos musicales (películas, series, deportes) hay otros titulares y otras entidades; pregunta a la OSA y a la Dirección Nacional de Derecho de Autor qué más aplica a tu caso.
- **La licencia de la OSA no reemplaza el permiso de YouTube.** La OSA autoriza el uso de las obras; YouTube decide sobre el uso de su plataforma.

Probablemente los bares de El Chupe ya pagan OSA por la música ambiente. Hay que confirmar que la categoría declarada incluya **videos musicales en pantalla**, porque la tarifa puede cambiar.

## Rutas para operar legalmente

| Ruta | Qué exige | Estado en el sistema |
|---|---|---|
| **A. Catálogo de video con licencia comercial** | Contrato con un proveedor de videos musicales para negocios que incluya exhibición pública en Colombia y entregue archivos o una API de reproducción, más OSA | Arquitectura lista: se escribe un proveedor en `src/providers/` y su adaptador en `public/tv/players.js`. El catálogo por URL ya funciona para archivos |
| **B. Contenido propio o cedido directamente** | Autorización escrita del artista o sello (por ejemplo artistas locales, o los que maneja tu operación de booking), más OSA cuando la obra esté en su repertorio | Funciona hoy: Panel → Catálogo autorizado. Es el único modo con crossfade |
| **C. YouTube** | Permiso previo por escrito de YouTube para exhibición pública, más auditoría de cuota aprobada, más OSA | Implementado y apagado. Sin crossfade, sin control sobre anuncios ni disponibilidad |

La ruta C depende de una respuesta que YouTube no suele dar a establecimientos individuales. La recomendación es avanzar por A y B, y tratar C como una gestión paralela sin fecha.

Sobre la ruta A: existen servicios de música y video para negocios (por ejemplo Stingray Business o Rockbot), pero **no se verificó** que operen en Colombia, que incluyan videos musicales con petición de canciones, ni sus precios. Hay que cotizar y pedir por escrito el alcance de la licencia (país, exhibición pública, video, uso en rockola interactiva).

## Autorizaciones pendientes

Nada de esto bloquea las pruebas con contenido DEMO. Todo esto bloquea poner música de terceros en un bar.

- [ ] **OSA**: confirmar por sede que la licencia vigente cubre videos musicales en pantalla; ajustar la categoría si hace falta. <https://www.osa.org.co/>
- [ ] **Proveedor de catálogo (ruta A)**: cotizar y obtener contrato con alcance escrito.
- [ ] **Autorizaciones directas (ruta B)**: un documento firmado por cada titular; registrar el origen en el campo «Origen del derecho de uso» de cada ítem.
- [ ] **YouTube (ruta C, opcional)**: solicitar permiso escrito para exhibición pública mediante el formulario de YouTube API Services, describiendo el caso tal cual es. No encender `YOUTUBE_HABILITADO` sin esa respuesta.
- [ ] **Si se llega a usar YouTube**: completar la auditoría de cumplimiento y publicar términos de uso propios que indiquen que el usuario acepta los Términos de YouTube.
- [ ] **Datos personales (Ley 1581 de 2012)**: completar en `/privacidad` la razón social, NIT y correo del responsable; enlazar la política de tratamiento de El Chupe S.A.S.; verificar con el abogado si aplica el registro de bases de datos ante la SIC. El teléfono viene desactivado por defecto: mientras no se pida, solo se guarda un alias.
- [ ] **Abogado**: validar este documento.

## Servicios externos necesarios

| Servicio | Para qué | Obligatorio |
|---|---|---|
| Hosting Node.js con HTTPS (Railway) | Servidor de la aplicación | Sí |
| PostgreSQL (Railway) | Base de datos | Sí |
| Dominio propio | URL corta y estable para el QR | Recomendado |
| Alojamiento de archivos | Videos del catálogo autorizado | Solo rutas A/B con archivos |
| Google Cloud + YouTube Data API | Búsqueda en YouTube | Solo ruta C |
| Licencia OSA | Comunicación pública | Sí, con música de terceros |
| Proveedor de catálogo con licencia | Contenido | Ruta A |

## Costos

### Verificados (precios publicados, consultados el 13 de octubre de 2026)

| Concepto | Precio |
|---|---|
| Railway, plan Hobby | USD 5 al mes de consumo mínimo, con USD 5 de uso incluido |
| Railway, plan Pro | USD 20 al mes de consumo mínimo, con USD 20 de uso incluido |
| Railway, memoria | USD 0,00000386 por GB por segundo (≈ USD 10 por GB al mes) |
| Railway, CPU | USD 0,00000772 por vCPU por segundo (≈ USD 20 por vCPU al mes) |
| Railway, volumen | USD 0,00000006 por GB por segundo (≈ USD 0,16 por GB al mes) |
| Railway, tráfico de salida | USD 0,05 por GB |
| YouTube Data API | Sin costo en dinero; límite de 10.000 unidades diarias |

### Estimado de hosting para todas las sedes

Supuestos: una instancia de la aplicación con unos 0,25 GB de memoria, PostgreSQL con unos 0,3 GB, uso promedio de 0,05 vCPU entre ambos, 1 GB de disco y menos de 5 GB de tráfico al mes (solo texto: los videos no pasan por el servidor).

| Rubro | Cálculo | USD al mes |
|---|---|---|
| Memoria | 0,55 GB × 10 | 5,5 |
| CPU | 0,05 vCPU × 20 | 1,0 |
| Disco | 1 GB × 0,16 | 0,2 |
| Tráfico | 5 GB × 0,05 | 0,3 |
| **Total estimado** | | **≈ 7** |

Con el plan Hobby la factura esperada queda entre **USD 5 y 10 al mes para todas las sedes juntas**. Es una estimación: el consumo real se ve en el panel de Railway tras la primera semana. No se midió bajo carga de un bar lleno.

### No verificados (hay que cotizar)

| Concepto | Por qué no hay cifra |
|---|---|
| Licencia OSA | Depende de la categoría del establecimiento, el municipio y el uso; se calcula en su simulador o con un asesor |
| Proveedor de catálogo con licencia | No se confirmó ninguno con cobertura en Colombia |
| Dominio | Depende del registrador y de la extensión |
| Mini PC por sede | Sirve un computador que ya tengan; el precio de uno nuevo no se consultó |
| Alojamiento de archivos de video | Depende del tamaño del catálogo |

## Fuentes

- [Términos del Servicio de YouTube](https://www.youtube.com/static?template=terms), sección «Permisos y restricciones»
- [YouTube API Services – Developer Policies](https://developers.google.com/youtube/terms/developer-policies), actualizadas el 14 de septiembre de 2026
- [YouTube API Services – Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [Formulario de auditoría y ampliación de cuota](https://support.google.com/youtube/contact/yt_api_form)
- [Organización Sayco Acinpro](https://www.osa.org.co/)
- [Precios de Railway](https://railway.com/pricing)
