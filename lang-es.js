// Spanish for the gym page (activity.html). The page is written in English;
// this file swaps what is shown on screen for Spanish, as it appears.
// On when the phone's language is Spanish or someone taps "Español"
// (remembered on this phone). Times stay as the check-in system shows them
// (e.g. 1:49 AM) so they still match the front-desk log exactly.
(function () {
  'use strict';
  var KEY = 'sai:lang';
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }
  var q = /[?&]lang=(es|en)\b/.exec(location.search);
  var want = q ? q[1] : (saved() || (/^es\b/i.test(navigator.language || '') ? 'es' : 'en'));
  if (q) save(q[1]);
  window.SAI_LANG = want;

  // Exact phrases (as shown, spaces collapsed).
  var ES = {
    '(a day pass)': '(un pase de día)',
    '(hours nobody is at the desk): stricter alerts. Less certain flags and "maybe a second person" entries alert too, marked "worth a look". More alerts, nothing missed.': '(horas sin nadie en recepción): alertas más estrictas. También avisan las marcas menos seguras y las entradas de "quizás una segunda persona", marcadas "vale la pena revisar". Más alertas, nada se escapa.',
    '(last 4 weeks ·': '(últimas 4 semanas ·',
    '(open house, guest night): no tailgate alerts for a few hours. Entries are still recorded.': '(puertas abiertas, noche de invitados): sin alertas de colados por unas horas. Las entradas se siguen registrando.',
    '(owner only). Shorter is more private; the monthly report then covers less.': '(solo el dueño). Menos tiempo es más privado; el informe mensual cubre menos.',
    '(owner only). Shows on this page, the front-desk screen and the lobby TV. PNG or JPEG under 200 KB.': '(solo el dueño). Se ve en esta página, en la pantalla de recepción y en la TV del vestíbulo. PNG o JPEG de menos de 200 KB.',
    'A buzz the moment something is flagged.': 'Un aviso en cuanto se marca algo.',
    'A few entries the camera called normal, picked at random. Glance at each photo: this is how we find out if the camera ever misses someone.': 'Unas pocas entradas que la cámara llamó normales, elegidas al azar. Mira cada foto: así sabemos si la cámara alguna vez se pierde a alguien.',
    'A question, a problem, an idea. TJ replies the same business day. Urgent? Call': 'Una pregunta, un problema, una idea. TJ responde el mismo día hábil. ¿Urgente? Llama al',
    'A second person walks through right behind the first, on the same turn, without stopping at the reader.': 'Una segunda persona pasa justo detrás de la primera, en el mismo giro, sin pasar por el lector.',
    'About 2 minutes: how we find out if the camera ever misses someone.': 'Unos 2 minutos: así sabemos si la cámara alguna vez se pierde a alguien.',
    'Add': 'Agregar',
    'Add a note (optional)': 'Agregar una nota (opcional)',
    'Add an email, mobile number or chat channel': 'Agrega un correo, un celular o un canal de chat',
    'Add and invite': 'Agregar e invitar',
    'Add someone': 'Agregar a alguien',
    'Add yourself to alerts': 'Agrégate a las alertas',
    'Alerts': 'Alertas',
    'All clear': 'Todo bien',
    'All day and night. Camera picture OK.': 'Todo el día y la noche. Imagen de la cámara bien.',
    'All your gyms': 'Todos tus gimnasios',
    'Answer your first flagged entry': 'Responde tu primera entrada marcada',
    'Any other number?': '¿Cualquier otro número?',
    'Anyone with this link can see this one entry and its photos — nothing else.': 'Quien tenga este enlace puede ver solo esta entrada y sus fotos, nada más.',
    'Anything odd goes to the top': 'Lo raro aparece arriba',
    'Ask': 'Preguntar',
    'Ask about your numbers': 'Pregunta sobre tus números',
    'Ask for access on this phone': 'Pedir acceso en este teléfono',
    'Asked once on this phone. It shows who checked each entry, so the owner knows who to thank.': 'Se pregunta una vez en este teléfono. Muestra quién revisó cada entrada, para que el dueño sepa a quién agradecer.',
    'Before you charge anyone:': 'Antes de cobrarle a alguien:',
    'Camera problems': 'Problemas de cámara',
    'Check the time in your scan system': 'Revisa la hora en tu sistema de registros',
    'Check them now': 'Revisarlas ahora',
    'Close': 'Cerrar',
    'Confirmed tailgates, week by week': 'Colados confirmados, semana por semana',
    'Contact SecurityAI': 'Contactar a SecurityAI',
    'Copy link': 'Copiar enlace',
    'Couldn’t load it just now.': 'No se pudo cargar ahora.',
    'Counts only go up when someone taps': 'Los conteos solo suben cuando alguien toca',
    'Do the weekly spot-check': 'Haz la revisión semanal',
    'Done': 'Listo',
    'Don’t charge anyone': 'No le cobres a nadie',
    'Door sign and member notice': 'Letrero de la puerta y aviso para socios',
    'Download spreadsheet': 'Descargar hoja de cálculo',
    "Each entry shows exactly which seconds to look at. Tap what you found: that's it.": 'Cada entrada muestra exactamente qué segundos revisar. Toca lo que encontraste: eso es todo.',
    'Email me a link': 'Envíame un enlace',
    'Email, text or a team chat. You get a test straight away.': 'Correo, mensaje de texto o chat del equipo. Recibes una prueba enseguida.',
    'End now': 'Terminar ahora',
    'Enter your gym code': 'Escribe el código de tu gimnasio',
    'Entrance activity': 'Actividad de la entrada',
    'Entries by hour': 'Entradas por hora',
    'Event mode': 'Modo evento',
    'Every entry is photographed and counted. People leaving are ignored.': 'Cada entrada se fotografía y se cuenta. Las personas que salen no cuentan.',
    'Everyone signs in with their own email.': 'Cada quien entra con su propio correo.',
    'Fewer scans than people came in': 'Menos escaneos que personas que entraron',
    'Fine': 'Bien',
    'First name': 'Nombre',
    'Flagged': 'Marcadas',
    'Flagged and marked entries': 'Entradas marcadas y confirmadas',
    'Flagged first': 'Marcadas primero',
    'Forgot your code?': '¿Olvidaste tu código?',
    'Front-desk screen': 'Pantalla de recepción',
    'Get a buzz on this phone when someone gets in without their own scan, or the camera has a problem. Free, and only this phone.': 'Recibe un aviso en este teléfono cuando alguien entra sin su propio escaneo o la cámara tiene un problema. Gratis, y solo en este teléfono.',
    'Get alerts': 'Recibir alertas',
    'Get it for your gym →': 'Tenlo en tu gimnasio →',
    'Getting started': 'Primeros pasos',
    'Got it': 'Entendido',
    'Green: normal': 'Verde: normal',
    'Gym code': 'Código del gimnasio',
    'Gym logo': 'Logo del gimnasio',
    'Gym settings': 'Ajustes del gimnasio',
    'Help': 'Ayuda',
    'Hide': 'Ocultar',
    'How long photos are kept': 'Cuánto tiempo se guardan las fotos',
    'How this page works': 'Cómo funciona esta página',
    'If someone scanned twice in a row, count them once.': 'Si alguien escaneó dos veces seguidas, cuéntalo una vez.',
    'If that member was already inside before this, they handed over their code.': 'Si ese socio ya estaba adentro antes de esto, pasó su código a otra persona.',
    'If the gym added you, we email you a one-time sign-in link. No password.': 'Si el gimnasio te agregó, te enviamos por correo un enlace para entrar una sola vez. Sin contraseña.',
    'In the chat app, make an': 'En la app de chat, crea un',
    'It was fine': 'Todo bien',
    'It was fine ·': 'Todo bien ·',
    "It's in the message SecurityAI sent you: your gym's name, a dash, then 6 letters and numbers. You only need to do this once on each phone or computer.": 'Está en el mensaje que te envió SecurityAI: el nombre de tu gimnasio, un guion y luego 6 letras y números. Solo hace falta una vez en cada teléfono o computadora.',
    'Keep photos for a dispute': 'Guardar las fotos por una disputa',
    'Larger text': 'Texto más grande',
    'Normal text': 'Texto normal',
    'Leaving': 'Saliendo',
    'Loading…': 'Cargando…',
    'Looks like someone got in without their own scan.': 'Parece que alguien entró sin su propio escaneo.',
    'Looks right': 'Se ve bien',
    'Manager': 'Gerente',
    'Managers': 'Gerentes',
    'Mark done': 'Marcar como hecho',
    'Member numbers': 'Números de socio',
    'Members should know the door camera checks entries.': 'Los socios deben saber que la cámara de la puerta revisa las entradas.',
    'Message': 'Mensaje',
    'Message TJ': 'Escribir a TJ',
    'Message TJ at SecurityAI': 'Escribir a TJ de SecurityAI',
    'Monthly report': 'Informe mensual',
    'Morning summary': 'Resumen de la mañana',
    'Next ›': 'Siguiente ›',
    'Night mode': 'Modo nocturno',
    'No tailgates flagged ✓': 'Ningún colado marcado ✓',
    'Nobody yet — add yourself below.': 'Nadie todavía. Agrégate abajo.',
    'Not now': 'Ahora no',
    'Note': 'Nota',
    'Nothing here is real. Tap around: answer an entry, mark what happened, add yourself to alerts.': 'Nada de esto es real. Explora: responde una entrada, marca qué pasó, agrégate a las alertas.',
    'Notifications are blocked for this site in the phone’s settings. Allow them there, then try again.': 'Las notificaciones de este sitio están bloqueadas en los ajustes del teléfono. Permítelas ahí y vuelve a intentar.',
    'Notifications on this phone': 'Notificaciones en este teléfono',
    'Off.': 'Apagado.',
    'On a keyboard:': 'Con teclado:',
    'One person per swipe, as expected. People leaving are listed here too.': 'Una persona por escaneo, como se espera. Las personas que salen también aparecen aquí.',
    'One sneak-in costs us $': 'Cada colado nos cuesta $',
    'Open': 'Abierto',
    'Open alerts': 'Abrir alertas',
    'Opened from your home screen? Enter the code once more.': '¿Lo abriste desde la pantalla de inicio? Escribe el código una vez más.',
    'Or sign in with your email': 'O entra con tu correo',
    'Owner': 'Dueño',
    'Owners': 'Dueños',
    'Passed': 'Sin problema',
    'People': 'Personas',
    'Photos': 'Fotos',
    'Photos are deleted after 48 hours. Flagged entries, and any you mark Tailgate or Shared code, are kept 35 days for the monthly report.': 'Las fotos se borran después de 48 horas. Las entradas marcadas, y las que marques como Se coló o Código compartido, se guardan 35 días para el informe mensual.',
    'Print the sign': 'Imprimir el letrero',
    'Probably fine, but the camera couldn’t be sure. A quick look is enough.': 'Probablemente bien, pero la cámara no pudo estar segura. Basta con un vistazo.',
    'Put the sign up at the entrance': 'Pon el letrero en la entrada',
    'Put this page on your home screen: it opens like an app, already signed in.': 'Pon esta página en tu pantalla de inicio: se abre como una app, ya con tu sesión.',
    'Questions?': '¿Preguntas?',
    'Reconnecting to your camera…': 'Reconectando con tu cámara…',
    'Red = looks like a tailgate or a shared code. Yellow = worth a quick look. Green = normal.': 'Rojo = parece un colado o un código compartido. Amarillo = vale la pena un vistazo. Verde = normal.',
    'Red: likely got in without paying': 'Rojo: probablemente entró sin pagar',
    'Remove': 'Quitar',
    'Remove logo': 'Quitar logo',
    'Results': 'Resultados',
    'Results so far': 'Resultados hasta ahora',
    'Review one by one': 'Revisar una por una',
    'Sample gym.': 'Gimnasio de muestra.',
    'Sample gym: nothing here is real, and nothing you tap is saved anywhere.': 'Gimnasio de muestra: nada de esto es real y nada de lo que toques se guarda.',
    'Save': 'Guardar',
    'Save staff times': 'Guardar horarios del personal',
    'Scan ✓': 'Escaneo ✓',
    'SecurityAI entrance watch': 'Vigilancia de entrada SecurityAI',
    'See exactly which member each flagged person came in behind. For privacy, TJ approves each phone first, and member numbers can only be opened on approved phones.': 'Mira exactamente detrás de qué socio entró cada persona marcada. Por privacidad, TJ aprueba cada teléfono primero, y los números de socio solo se pueden abrir en teléfonos aprobados.',
    'Send': 'Enviar',
    'Send a test': 'Enviar una prueba',
    'Send alerts to Slack, Teams, Google Chat or Discord': 'Enviar alertas a Slack, Teams, Google Chat o Discord',
    'Send test': 'Enviar prueba',
    'Send this': 'Enviar esto',
    'Send this entry': 'Enviar esta entrada',
    'Shared code': 'Código compartido',
    'Shared code ·': 'Código compartido ·',
    'Sign out on this device': 'Cerrar sesión en este dispositivo',
    'Skip': 'Omitir',
    'Someone got in without paying': 'Alguien entró sin pagar',
    'Someone inside passes a phone back through the bars before a second person scans in.': 'Alguien de adentro pasa un teléfono por las barras antes de que una segunda persona escanee.',
    'Someone leaving': 'Alguien saliendo',
    'Someone may have followed a member in': 'Alguien pudo haber entrado detrás de un socio',
    'Someone may have scanned in on another member’s phone': 'Alguien pudo haber escaneado con el teléfono de otro socio',
    'Someone used another member’s code': 'Alguien usó el código de otro socio',
    'Something doesn’t line up (a missed or extra scan).': 'Algo no cuadra (un escaneo de menos o de más).',
    'Staff': 'Personal',
    'Staff times (one per line, 24-hour clock)': 'Horarios del personal (uno por línea, reloj de 24 horas)',
    'Step 2 · What did you find?': 'Paso 2 · ¿Qué encontraste?',
    'Suggested': 'Sugerido',
    'Suggested:': 'Sugerido:',
    'Tailgate': 'Se coló',
    'Tailgate alerts': 'Alertas de colados',
    'Tailgate ·': 'Se coló ·',
    'Takes about a minute each morning.': 'Toma como un minuto cada mañana.',
    'Tap Tailgate, Shared code or It was fine. That’s how the counts and reports fill in.': 'Toca Se coló, Código compartido o Todo bien. Así se llenan los conteos y los informes.',
    'That scan is the member who let the extra person in.': 'Ese escaneo es el socio que dejó entrar a la persona de más.',
    'That scan is the member whose code was shared.': 'Ese escaneo es el socio cuyo código se compartió.',
    'The gym logo, how long photos are kept and who has read member numbers are owner settings. They show here when you sign in with the owner\'s email.': 'El logo, cuánto tiempo se guardan las fotos y quién ha leído números de socio son ajustes del dueño. Aparecen aquí cuando entras con el correo del dueño.',
    'The scans match, or it was staff': 'Los escaneos cuadran, o era personal',
    "They'll get a test message straight away, with a link to stop alerts any time.": 'Recibirán un mensaje de prueba enseguida, con un enlace para dejar las alertas cuando quieran.',
    'This month:': 'Este mes:',
    'This usually takes under a minute.': 'Esto suele tomar menos de un minuto.',
    'Timeline': 'Cronología',
    'Times are Central Time.': 'Las horas son de la zona central.',
    'To check': 'Por revisar',
    'Today': 'Hoy',
    'Turn off': 'Apagar',
    'Turn on': 'Encender',
    'Turn on notifications on this phone': 'Activa las notificaciones en este teléfono',
    'Two people come through close together; each seems to take their own turn.': 'Dos personas pasan muy juntas; cada una parece usar su propio giro.',
    'Watching your entrance': 'Vigilando tu entrada',
    "We watch all day and night. When something's flagged, we'll email or text these people with a photo. They're also told if the camera computer goes offline.": 'Vigilamos todo el día y la noche. Cuando se marca algo, avisamos a estas personas por correo o mensaje con una foto. También se les avisa si la computadora de la cámara se desconecta.',
    'We watch your turnstile at night': 'Vigilamos tu torniquete de noche',
    'Weekly spot-check': 'Revisión semanal',
    'What the camera saw': 'Lo que vio la cámara',
    "What's new": 'Novedades',
    "What's new •": 'Novedades •',
    'What’s your first name?': '¿Cuál es tu nombre?',
    "When something's flagged, we'll email or text these people with a photo.": 'Cuando se marca algo, avisamos a estas personas por correo o mensaje con una foto.',
    'When staff or expected visitors come in without scanning, their entries can look like tailgates. List those times and flags then say "probably staff". Nothing is hidden.': 'Cuando el personal o visitas esperadas entran sin escanear, esas entradas pueden parecer colados. Anota esos horarios y las marcas dirán "probablemente personal". No se oculta nada.',
    'Who has read member numbers (last 90 days)': 'Quién ha leído números de socio (últimos 90 días)',
    'Worth a check': 'Vale la pena revisar',
    'Yellow: a quick look': 'Amarillo: un vistazo',
    'Your email': 'Tu correo',
    'Your email (the one SecurityAI has for your gym)': 'Tu correo (el que SecurityAI tiene de tu gimnasio)',
    'Your name': 'Tu nombre',
    "also decide who's here. Removing someone stops their sign-in straight away.": 'también deciden quién tiene acceso. Quitar a alguien detiene su acceso de inmediato.',
    'also run the alert list and the sneak-in price.': 'también manejan la lista de alertas y el precio por colado.',
    'check entries.': 'revisan entradas.',
    'checked and fine': 'revisadas y bien',
    'entries checked': 'entradas revisadas',
    'flagged': 'marcadas',
    'flagged)': 'marcadas)',
    'for the channel (Slack: Apps > Incoming Webhooks; Teams: channel > Workflows > "Post to a channel when a webhook request is received"; Google Chat: space > Apps & integrations > Webhooks). Paste its link above. Chat messages say what happened and link here; photos stay behind the sign-in.': 'para el canal (Slack: Apps > Incoming Webhooks; Teams: canal > Workflows > "Post to a channel when a webhook request is received"; Google Chat: espacio > Apps e integraciones > Webhooks). Pega su enlace arriba. Los mensajes del chat dicen qué pasó y enlazan aquí; las fotos solo se ven con sesión iniciada.',
    'for this one.': 'para esta.',
    'incoming webhook': 'webhook de entrada',
    'missed': 'se perdió',
    'next ·': 'siguiente ·',
    'night watched': 'noche vigilada',
    'nights watched': 'noches vigiladas',
    'on an entry. The spreadsheet lists each one with its time — no photos.': 'en una entrada. La hoja de cálculo muestra cada una con su hora, sin fotos.',
    'or': 'o',
    'people in without their own scan': 'personas que entraron sin su propio escaneo',
    'shared codes confirmed': 'códigos compartidos confirmados',
    'spot-checked,': 'revisadas al azar,',
    'tailgates confirmed': 'colados confirmados',
    'the person who snuck in didn’t scan, so they’re not in the list. The scan you find is the member who let them in. Check the photos show the extra person right behind them.': 'la persona que se coló no escaneó, así que no está en la lista. El escaneo que encuentres es el socio que la dejó entrar. Confirma que las fotos muestran a la persona de más justo detrás.',
    'this week': 'esta semana',
    'undo': 'deshacer',
    'waiting for you': 'esperándote',
    '· about 2 minutes': '· unos 2 minutos',
    '‹ Previous': '‹ Anterior',
    '▶ Play': '▶ Reproducir',
    'Colour key': 'Clave de colores',
    'How to list entries': 'Cómo listar las entradas',
    'Night hours, 24-hour clock': 'Horas nocturnas, reloj de 24 horas',
    'Photo': 'Foto',
    'Play the photos in order, like a short video': 'Reproducir las fotos en orden, como un video corto',
    'Role': 'Rol',
    'Sections': 'Secciones',
    'Show photos full screen': 'Ver fotos en pantalla completa',
    'Email': 'Correo',
    'Email, mobile number or chat webhook link': 'Correo, celular o enlace de webhook del chat',
    'e.g. How many tailgates last week?': 'p. ej. ¿Cuántos colados hubo la semana pasada?',
    'e.g. Sarah': 'p. ej. Sara',
    'e.g. Sarah, manager': 'p. ej. Sara, gerente',
    'e.g. member\'s name, or “cleaner”': 'p. ej. nombre del socio, o “limpieza”',
    'you@example.com': 'tu@ejemplo.com',
    'Repeat check: who let someone in more than once': 'Revisión de repetidos: quién dejó entrar a alguien más de una vez',
    'Find a member (searched on this phone only)': 'Buscar un socio (la búsqueda se hace solo en este teléfono)',
    'Member number': 'Número de socio',
    'Find': 'Buscar',
    'Type at least 2 digits.': 'Escribe al menos 2 dígitos.',
    'Saved.': 'Guardado.',
    'Hidden.': 'Oculto.',
    'Night mode saved.': 'Modo nocturno guardado.',
    'Night mode off.': 'Modo nocturno apagado.',
    'Staff times saved.': 'Horarios del personal guardados.',
    'Logo saved.': 'Logo guardado.',
    'Couldn’t save that.': 'No se pudo guardar.',
    'Choose a PNG or JPEG picture.': 'Elige una imagen PNG o JPEG.',
    'That picture is too big. Use one under 200 KB.': 'Esa imagen es muy grande. Usa una de menos de 200 KB.',
    'Offline: showing the last list': 'Sin conexión: mostrando la última lista',
    'Can’t reach SecurityAI right now': 'No se puede conectar con SecurityAI ahora',
    'Check this phone has signal. The page will try again by itself.': 'Revisa que este teléfono tenga señal. La página volverá a intentar sola.',
    'Showing what was already loaded. The page will try again by itself.': 'Mostrando lo que ya estaba cargado. La página volverá a intentar sola.',
    'No signal: saved on this phone. It sends by itself when you are back online.': 'Sin señal: guardado en este teléfono. Se envía solo cuando vuelvas a tener conexión.',
    'Copied. Paste it into a text or email, and edit it as you like.': 'Copiado. Pégalo en un mensaje o correo y edítalo como quieras.',
    'Copied — paste it into a text or email.': 'Copiado: pégalo en un mensaje o correo.',
    'Copy a friendly message to send them': 'Copiar un mensaje amable para enviarle',
    "Only send it when you're sure who it was: the photos and the scan agree.": 'Envíalo solo cuando estés seguro de quién fue: las fotos y el escaneo coinciden.',
    'What happened next?': '¿Qué pasó después?',
    'Change': 'Cambiar',
    'Charged': 'Se le cobró',
    'Talked to them': 'Se habló con la persona',
    'Warning given': 'Se le advirtió',
    'Couldn’t reach them': 'No se le pudo contactar',
    'They disputed it': 'Lo disputó',
    'Kept for a dispute': 'Guardada por una disputa',
    'Everything flagged has been checked': 'Todo lo marcado ya se revisó',
    'Nothing yet': 'Nada todavía',
    'No entries in the last 48 hours.': 'Sin entradas en las últimas 48 horas.',
    'No entries yet': 'Sin entradas todavía',
    'Nothing to show yet': 'Nada que mostrar todavía',
    'Setup in progress': 'Instalación en curso',
    'Your camera isn’t connected yet. Anything flagged will show up here once it is.': 'Tu cámara aún no está conectada. Todo lo marcado aparecerá aquí cuando lo esté.',
    'All done': 'Todo listo',
    'Gym code or email': 'Código del gimnasio o correo',
    'Sign in': 'Entrar',
    'Español': 'Español',
    'Someone leaving: the camera computer saw them walk out, so this one was not sent to the AI.': 'Alguien saliendo: la computadora de la cámara lo vio salir, así que esta no se envió a la IA.',
    'Second look': 'Segunda revisión',
    '· owner only': '· solo el dueño',
    'Answers of “It was fine” where the camera and the front-desk scans both showed an extra person. Check the photos and the reason. Agree, or change it to Tailgate.': 'Respuestas de “Todo bien” donde la cámara y los escaneos de recepción mostraron a una persona de más. Revisa las fotos y el motivo. Acepta, o cámbialo a Se coló.',
    'Agree: it was fine': 'De acuerdo: todo bien',
    'Change to Tailgate': 'Cambiar a Se coló',
    'Nothing waiting.': 'Nada pendiente.',
    'Photos already deleted.': 'Las fotos ya se borraron.',
    'Last 30 days:': 'Últimos 30 días:',
    'Marked as checked.': 'Marcado como revisado.',
    'Changed to Tailgate.': 'Cambiado a Se coló.',
    'The camera and the front-desk scans both show an extra person. To answer': 'La cámara y los escaneos de recepción muestran a una persona de más. Para responder',
    ', write why in the note. The owner sees those answers.': ', escribe el motivo en la nota. El dueño ve esas respuestas.',
    'Note (needed for “It was fine”)': 'Nota (necesaria para “Todo bien”)',
    'Write why it was fine in the note first (e.g. staff member, guest with a day pass).': 'Primero escribe en la nota por qué estuvo bien (p. ej. personal, invitado con pase de día).',
    'The camera and the front-desk scans both show an extra person. If it was fine, write why in the note (for example: staff member, guest with a day pass, scanner was down).': 'La cámara y los escaneos de recepción muestran a una persona de más. Si estuvo bien, escribe el motivo en la nota (por ejemplo: personal, invitado con pase de día, el lector no funcionaba).',
    'Trends and busiest hours, Review one by one, Getting started checklist, camera problems inbox, Slack/Teams/Google Chat alerts, works without signal, printable report, gym logo, shorter photo keep times, find a member, Spanish members page.': 'Tendencias y horas con más entradas, Revisar una por una, lista de Primeros pasos, problemas de cámara, alertas en Slack/Teams/Google Chat, funciona sin señal, informe para imprimir, logo del gimnasio, fotos guardadas menos tiempo, buscar un socio, página para socios en español.',
    'Phone notifications, a front-desk screen (/desk), personal logins, "Ask about your numbers", ▶ Play, answers saved without signal.': 'Notificaciones en el teléfono, pantalla de recepción (/desk), acceso personal, "Pregunta sobre tus números", ▶ Reproducir, respuestas guardadas sin señal.',
    'Weekly spot-check, "What happened next" with $ charged, suggested answers, Undo, staff times and event mode.': 'Revisión semanal, "¿Qué pasó después?" con $ cobrados, respuestas sugeridas, Deshacer, horarios del personal y modo evento.',
    'Spanish for the gym page, repeat check on approved phones, day-pass message tied to certain entries, night mode, all-gyms view.': 'Página del gimnasio en español, revisión de repetidos en teléfonos aprobados, mensaje de pase de día solo para entradas seguras, modo nocturno, vista de todos los gimnasios.',
  };

  // Text with numbers, names or times in it.
  var RX = [
    [/^(\d+) waiting$/, '$1 esperando'],
    [/^(\d+) of (\d+) done$/, '$1 de $2 listos'],
    [/^(\d+) of (\d+) done this week\.$/, '$1 de $2 listas esta semana.'],
    [/^1 person — normal$/, '1 persona: normal'],
    [/^(\d+) people — normal$/, '$1 personas: normal'],
    [/^(\d+) people came in, only (\d+) scans?$/, '$1 personas entraron, solo $2 escaneo(s)'],
    [/^(\d+) people seen and (\d+) scans — probably fine$/, '$1 personas vistas y $2 escaneos: probablemente bien'],
    [/^Camera: (\d+) people$/, 'Cámara: $1 personas'],
    [/^Camera: 1 person$/, 'Cámara: 1 persona'],
    [/^Front desk: (\d+) scans?$/, 'Recepción: $1 escaneo(s)'],
    [/^Show (\d+) entries$/, 'Ver $1 entradas'],
    [/^(\d+) photos$/, '$1 fotos'],
    [/^(\d+) hours$/, '$1 horas'],
    [/^(\d+) days$/, '$1 días'],
    [/^(\d+) weeks ago$/, 'hace $1 semanas'],
    [/^Since (.+)$/, function (m, d) { return 'Desde ' + dates(d); }],
    [/^Photos kept until (.+)$/, function (m, d) { return 'Fotos guardadas hasta ' + dates(d); }],
    [/^Today, (.+) · (\d+) h ago · (.+)$/, 'Hoy, $1 · hace $2 h · $3'],
    [/^Today, (.+) · (\d+) min ago · (.+)$/, 'Hoy, $1 · hace $2 min · $3'],
    [/^Yesterday, (.+)$/, 'Ayer, $1'],
    [/^(\d+)\. Count the (.+) scans from (.+)\.$/, '$1. Cuenta los escaneos de $2 desde las $3.'],
    [/^(\d+)\. Exactly (\d+)\?$/, '$1. ¿Exactamente $2?'],
    [/^Copy the times to check \((\d+)\)$/, 'Copiar las horas a revisar ($1)'],
    [/^Busiest: (.+?)\.(?: Most flags: (.+)\.)?$/, function (m, a, b) { return 'Más entradas: ' + a + '.' + (b ? ' Más marcas: ' + b + '.' : ''); }],
    [/^Confirmed tailgates per 100 entries: ([\d.]+) in the first two weeks, ([\d.]+) in the last two \((down|up) (\d+)%\)\.$/, function (m, a, b, d, p) { return 'Colados confirmados por cada 100 entradas: ' + a + ' en las primeras dos semanas, ' + b + ' en las últimas dos (' + (d === 'down' ? 'bajó' : 'subió') + ' ' + p + '%).'; }],
    [/^Flagged entries per 100 entries: ([\d.]+) in the first two weeks, ([\d.]+) in the last two \((down|up) (\d+)%\)\.$/, function (m, a, b, d, p) { return 'Entradas marcadas por cada 100 entradas: ' + a + ' en las primeras dos semanas, ' + b + ' en las últimas dos (' + (d === 'down' ? 'bajó' : 'subió') + ' ' + p + '%).'; }],
    [/^The before-and-after comparison shows up after two weeks with at least (\d+) entries\.$/, 'La comparación de antes y después aparece tras dos semanas con al menos $1 entradas.'],
    [/^(\d+) caught · \$([\d,.]+) charged$/, '$1 atrapados · $$$2 cobrados'],
    [/^(\d+) normal entr(?:y|ies)(?: · (\d+) (?:person|people) leaving)?$/, function (m, a, b) { return a + ' entrada(s) normal(es)' + (b ? ' · ' + b + ' saliendo' : ''); }],
    [/^Last 24 hours: (.+)$/, function (m, r) { return 'Últimas 24 horas: ' + r.split(' · ').map(part).join(' · '); }],
    [/^\. (\d+) people came in and the front desk has (\d+) scans?\. You decide\.$/, '. Entraron $1 personas y recepción tiene $2 escaneo(s). Tú decides.'],
    [/^\. Everyone the camera saw has their own scan \((\d+) for (\d+)\)\. You decide\.$/, '. Todos los que vio la cámara tienen su propio escaneo ($1 para $2). Tú decides.'],
    [/^Everyone the camera saw has a scan \((\d+) for (\d+)\), so probably two members close together\.$/, 'Todos los que vio la cámara tienen escaneo ($1 para $2), así que probablemente son dos socios muy juntos.'],
    [/^The front desk recorded (\d+) scans? for the (\d+) people the camera saw\.$/, 'Recepción registró $1 escaneo(s) para las $2 personas que vio la cámara.'],
    [/^Step 1 · In (.+)’s Visit Log, set the zone to (.+), and look at$/, 'Paso 1 · En el registro de visitas de $1, pon la zona $2 y revisa'],
    [/^for this one\. If there are fewer than (\d+) scans, it’s still a tailgate\. Mark it as one\.$/, 'para esta. Si hay menos de $1 escaneos, igual es un colado. Márcala así.'],
    [/^charged so far · \$([\d,.]+) in sneak-ins caught \(at \$([\d,.]+) each\)(?: · (\d+) confirmed still needs? a follow-up)?$/, function (m, a, b, c) { return 'cobrados hasta ahora · $' + a + ' en colados atrapados (a $' + b + ' cada uno)' + (c ? ' · ' + c + ' confirmado(s) aún sin seguimiento' : ''); }],
    [/^(\d+) scans? by (\d+)$/, '$1 escaneo(s) de $2'],
    [/^No scans by (\d+) in the last 48 hours\.$/, 'Ningún escaneo de $1 en las últimas 48 horas.'],
    [/^(\d+) confirmed tailgates? let in by (\d+) \((.+)\)$/, function (m, a, b, c) { return a + ' colado(s) confirmado(s) que dejó entrar ' + b + ' (' + dates(c) + ')'; }],
    [/^Copy a day-pass message for member (.+)$/, 'Copiar un mensaje de pase de día para el socio $1'],
    [/^On every night from (.+) to (.+) \(gym time\)\.$/, 'Activo cada noche de $1 a $2 (hora del gimnasio).'],
    [/^From (.+)\. Photos need signal\. Answers you tap are sent when it's back\.$/, function (m, d) { return 'De ' + dates(d) + '. Las fotos necesitan señal. Tus respuestas se envían cuando vuelva.'; }],
    [/^All (\d+) gyms:$/, 'Los $1 gimnasios:'],
    [/^(\d+) in today · (\d+) caught this month(.*)$/, function (m, a, b, c) { return a + ' hoy · ' + b + ' atrapados este mes' + c; }],
    [/^(\d+) to check$/, '$1 por revisar'],
    [/^(\d+) people in the last 24 h · (\d+) caught this month(.*)$/, function (m, a, b, c) { return a + ' personas en las últimas 24 h · ' + b + ' atrapados este mes' + c.replace(' charged', ' cobrados'); }],
    [/^(.+): (\d+) entries, (\d+) flagged$/, '$1: $2 entradas, $3 marcadas'],
    [/^(\d{4}-\d{2}-\d{2}): (\d+) confirmed of (\d+) entries$/, '$1: $2 confirmados de $3 entradas'],
    [/^Busiest hour (.+)$/, 'Hora con más entradas: $1'],
    [/^Confirmed tailgates per week, oldest first: (.+)$/, 'Colados confirmados por semana, del más antiguo: $1'],
    [/^(.+), (.+)\. Show photos$/, function (m, a, b) { return part(a) + ', ' + b + '. Ver fotos'; }],
    [/^Photo (\d+)$/, 'Foto $1'],
    [/^· camera (.+) people, front desk (\d+) scans?$/, '· cámara $1 personas, recepción $2 escaneo(s)'],
    [/^“It was fine” by (.+?): (.*)$/, '“Todo bien” de $1: $2'],
    [/^Changes: (.+)$/, function (m, r) { return 'Cambios: ' + r.replace(/\bTailgate\b/g, 'Se coló').replace(/\bShared code\b/g, 'Código compartido').replace(/\bIt was fine\b/g, 'Todo bien').replace(/\bcleared\b/g, 'borrada').replace(/fine \(owner agreed\)/g, 'todo bien (el dueño aceptó)'); }],
    [/^Remove (.+)$/, 'Quitar $1'],
    [/^What (.+) gets$/, 'Qué recibe $1'],
  ];
  var MONTHS = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio', July: 'julio', August: 'agosto', September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre', Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', Jun: 'jun', Jul: 'jul', Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
  var DAYS = { Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado', Sunday: 'domingo', Mon: 'lun', Tue: 'mar', Wed: 'mié', Thu: 'jue', Fri: 'vie', Sat: 'sáb', Sun: 'dom' };
  function dates(s) {
    return String(s).replace(/\b([A-Z][a-z]+)\b/g, function (w) { return MONTHS[w] || DAYS[w] || w; });
  }
  function part(s) {
    var k = String(s).trim();
    if (ES[k]) return ES[k];
    var p = [[/^(\d+) need a look$/, '$1 por revisar'], [/^(\d+) needs? a look$/, '$1 por revisar'], [/^(\d+) normal entr(?:y|ies)$/, '$1 entrada(s) normal(es)'], [/^(\d+) already checked$/, '$1 ya revisada(s)'], [/^(\d+) (?:person|people) leaving$/, '$1 saliendo'], [/^1 person — normal$/, '1 persona: normal'], [/^(\d+) people — normal$/, '$1 personas: normal']];
    for (var i = 0; i < p.length; i++) if (p[i][0].test(k)) return k.replace(p[i][0], p[i][1]);
    return k;
  }
  function tr(raw) {
    var k = String(raw).replace(/\s+/g, ' ').trim();
    if (!k) return null;
    if (Object.prototype.hasOwnProperty.call(ES, k)) return ES[k];
    for (var i = 0; i < RX.length; i++) {
      var r = RX[i][0];
      if (r.test(k)) return k.replace(r, RX[i][1]);
    }
    return null;
  }
  window.SAI_TR = tr;

  function doText(n) {
    var v = n.nodeValue; if (!v || !/[A-Za-z]/.test(v)) return;
    var p = n.parentElement; if (!p || p.closest('script,style,textarea,[contenteditable="true"],.mono,[data-no-tr]')) return;
    var t = tr(v); if (t == null || t === v.trim()) return;
    var lead = /^\s*/.exec(v)[0], tail = /\s*$/.exec(v)[0];
    n.nodeValue = lead + t + tail;
  }
  function doAttrs(el) {
    ['placeholder', 'aria-label', 'title'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a); if (!v) return;
      var t = tr(v); if (t != null && t !== v) el.setAttribute(a, t);
    });
  }
  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1) return;
    doAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  function addSwitch() {
    var foot = document.getElementById('bigBtn');
    if (!foot || document.getElementById('langBtn')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'langBtn'; b.className = foot.className; b.setAttribute('data-no-tr', '');
    b.textContent = want === 'es' ? 'English' : 'Español';
    b.addEventListener('click', function () { save(want === 'es' ? 'en' : 'es'); location.reload(); });
    foot.parentNode.insertBefore(b, foot.nextSibling);
  }

  function start() {
    addSwitch();
    if (want !== 'es') return;
    document.documentElement.lang = 'es';
    walk(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else m.addedNodes.forEach(walk);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });
    // Pop-up questions and warnings.
    var c = window.confirm, a = window.alert;
    window.confirm = function (m) { return c.call(window, tr(m) || m); };
    window.alert = function (m) { return a.call(window, tr(m) || m); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
