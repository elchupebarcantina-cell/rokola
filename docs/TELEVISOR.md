# Conectar el equipo al televisor

## Qué equipo usar

Un computador o mini PC con **Google Chrome o Microsoft Edge actualizado**, conectado al televisor por **HDMI** (el HDMI lleva también el sonido). Es la configuración para la que se optimizó y se probó la pantalla.

No se garantiza el funcionamiento en el navegador propio de un Smart TV, en un TV Box ni en un Chromecast: suelen traer navegadores viejos, bloquean el sonido automático o duermen la página.

Preferible con cable de red. Si es por wifi, que sea una red distinta a la de los clientes.

## Preparar el equipo (una sola vez)

1. Conecta el HDMI y deja el televisor como **única pantalla** o en modo duplicado. Resolución 1920×1080.
2. En el sistema operativo: sin suspensión, sin apagado de pantalla, sin protector de pantalla. La salida de audio debe ser el HDMI.
3. Pon al día el sistema y el navegador, y desactiva las actualizaciones automáticas en horario del bar.
4. Abre el navegador y entra a `https://<tu-dominio>/tv`.
5. **Vincula la pantalla** de una de estas dos formas:
   - Aparece un código de 6 dígitos. En tu celular: Panel → la sala → **Pantallas** → escribe el código → *Vincular pantalla*.
   - O inicia sesión en el panel en ese mismo equipo, entra a la sala y pulsa **Abrir pantalla del televisor**.
6. Guarda `/tv` como página de inicio del navegador.

La vinculación queda guardada en ese navegador. Si lo reinstalas o borras los datos de navegación, hay que vincular otra vez. Las pantallas que ya no se usen se quitan en **Pantallas → Desvincular**.

## Cada noche

1. Enciende el televisor y el equipo; abre `/tv`.
2. Pulsa **Iniciar noche**. Ese clic es obligatorio: los navegadores no dejan reproducir con sonido sin una acción de la persona. También activa la pantalla completa y genera el QR de la sesión.
3. Sube el volumen del televisor y del equipo.

## Pantalla completa

- La pantalla completa se aplica a **toda la aplicación**, no al video: así el QR y la fila quedan siempre visibles al lado del video.
- Si se sale (tecla `Esc`), aparece el botón **Pantalla completa** abajo a la derecha. También sirve `F11`.
- Con YouTube, el botón de pantalla completa del propio reproductor está desactivado con el parámetro oficial `fs=0`. Si aun así el navegador pusiera el video solo en pantalla completa, el QR dejaría de verse: pulsa `Esc` y luego **Pantalla completa**. Los demás controles y la marca de YouTube quedan visibles; nada de la aplicación se dibuja encima del reproductor.

## Arranque sin tocar nada (opcional)

Para que tras un corte de luz la música vuelva sola, crea un acceso directo que abra el navegador así y ponlo en el inicio del sistema:

```
chrome --kiosk --autoplay-policy=no-user-gesture-required https://<tu-dominio>/tv
```

Sin esa opción el sistema funciona igual, pero después de reiniciar el equipo alguien debe pulsar **Reanudar reproducción** en la pantalla.

## Si algo pasa

| Lo que se ve | Qué hacer |
|---|---|
| Franja roja «El navegador bloqueó el sonido automático» | Pulsa **Activar sonido** en la pantalla |
| «La noche sigue abierta» con un botón | Pulsa **Reanudar reproducción** (pasa tras reiniciar el equipo) |
| «Sin conexión con el servidor» o «Sin internet para cargar el video» | Revisa el internet del equipo. Se reintenta solo y la fila no se pierde |
| «Fallaron varias canciones seguidas…» | Revisa el internet y luego pulsa **Reanudar** en el panel |
| «Otra pantalla es la reproductora de esta sala» | Hay otra pestaña o equipo reproduciendo. Ciérralo, o pulsa **Usar esta pantalla** |
| «Vincula esta pantalla» | Se borraron los datos del navegador o se desvinculó: repite la vinculación |

Solo una pantalla reproduce por sala. Si la principal se cierra o se cuelga, a los 15 segundos otra pantalla abierta de la misma sala toma el control sola.
