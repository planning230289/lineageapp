/* =========================================================
   GUARDIAS DE ENTORNO: CONECTIVIDAD Y BATERÍA
   (js/nucleo/guardias-entorno.js)
   =========================================================
   Módulo puro (sin acoplamiento al DOM ni imports de Firebase
   por URL) que protege la integridad de los datos financieros:

     1. Bloqueo por Batería Baja (< 15% sin estar cargando),
        degradando con elegancia en navegadores sin Battery API
        (iOS/Safari, Firefox, Node).
     2. Verificación real de conectividad a Internet y Firebase
        con timeout seguro para no colgar la aplicación.
     3. Monitor reactivo (online/offline, levelchange/chargingchange)
        y estado consultable desde la capa de persistencia (db.js).
   ========================================================= */

export const UMBRAL_BATERIA_CRITICA = 0.15;
export const TIMEOUT_FIREBASE_MS = 4500;

let estadoGlobalEntorno = {
    bloqueado: false,
    motivo: null,
    detalle: null,
    porcentajeBateria: null
};

/**
 * Actualiza el estado global compartido para que módulos sin DOM
 * (como js/db.js) puedan consultar si el entorno está bloqueado.
 *
 * @param {Object} nuevoEstado
 */
function actualizarEstadoGlobal(nuevoEstado) {
    estadoGlobalEntorno = {
        bloqueado: Boolean(nuevoEstado?.bloqueado),
        motivo: nuevoEstado?.motivo ?? null,
        detalle: nuevoEstado?.detalle ?? null,
        porcentajeBateria: nuevoEstado?.porcentajeBateria ?? null
    };
}

/**
 * Restablece el estado global del entorno (útil en tests unitarios).
 */
export function resetearEstadoGlobalEntorno() {
    estadoGlobalEntorno = {
        bloqueado: false,
        motivo: null,
        detalle: null,
        porcentajeBateria: null
    };
}

/**
 * Indica si el entorno está actualmente bloqueado (por el monitor
 * activo o por `navigator.onLine === false`).
 *
 * En entornos de test donde el monitor no fue iniciado y
 * `navigator.onLine` no es `false`, devuelve `false`.
 *
 * @returns {boolean}
 */
export function entornoEstaBloqueado() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true;
    }
    return Boolean(estadoGlobalEntorno.bloqueado);
}

/**
 * Devuelve una copia del estado actual del entorno.
 *
 * @returns {{ bloqueado: boolean, motivo: string|null, detalle: string|null, porcentajeBateria: number|null }}
 */
export function obtenerEstadoEntorno() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false && !estadoGlobalEntorno.bloqueado) {
        return {
            bloqueado: true,
            motivo: 'SIN_INTERNET',
            detalle: 'Sin conexión a internet.',
            porcentajeBateria: estadoGlobalEntorno.porcentajeBateria
        };
    }
    return { ...estadoGlobalEntorno };
}

/**
 * Evalúa el nivel de batería y estado de carga usando `navigator.getBattery()`.
 *
 * Si la API no está soportada (iOS/Safari, Firefox, Node) o rechaza,
 * devuelve `{ soportado: false, bloqueado: false, nivel: null, cargando: null }`
 * sin bloquear la aplicación.
 *
 * Bloquea únicamente cuando `!battery.charging && battery.level < 0.15`.
 *
 * @param {Navigator|null} [nav]
 * @returns {Promise<{ soportado: boolean, bloqueado: boolean, nivel: number|null, cargando: boolean|null, porcentaje?: number }>}
 */
export async function evaluarBateria(nav = typeof navigator !== 'undefined' ? navigator : null) {
    if (!nav || typeof nav.getBattery !== 'function') {
        return { soportado: false, bloqueado: false, nivel: null, cargando: null };
    }

    try {
        const battery = await nav.getBattery();
        if (!battery || typeof battery.level !== 'number' || Number.isNaN(battery.level)) {
            return { soportado: false, bloqueado: false, nivel: null, cargando: null };
        }

        const nivel = Math.max(0, Math.min(1, battery.level));
        const cargando = Boolean(battery.charging);
        const porcentaje = Math.round(nivel * 100);
        const bloqueado = !cargando && nivel < UMBRAL_BATERIA_CRITICA;

        return {
            soportado: true,
            bloqueado,
            nivel,
            cargando,
            porcentaje
        };
    } catch (_) {
        return { soportado: false, bloqueado: false, nivel: null, cargando: null };
    }
}

/**
 * Determina si un error de Firestore proviene de una respuesta real del servidor
 * (lo que confirma conectividad con Firebase) o de un fallo de red/timeout.
 *
 * Detalle importante: si el usuario todavía no inició sesión, `firestore.rules`
 * rechaza la lectura con `permission-denied` (o `unauthenticated`). Recibir ese
 * código desde el servidor de Firestore CONFIRMA que hay conexión real con Firebase.
 * En cambio, `unavailable`, `deadline-exceeded` o errores de red/timeout indican
 * ausencia de conexión con Firebase.
 *
 * @param {*} error
 * @returns {boolean}
 */
function errorConfirmaRespuestaServidorFirebase(error) {
    const code = String(error?.code || '').toLowerCase();
    return (
        code === 'permission-denied' ||
        code === 'unauthenticated' ||
        code === 'not-found' ||
        code === 'already-exists' ||
        code === 'failed-precondition' ||
        code === 'invalid-argument'
    );
}

/**
 * Verifica conectividad real con Internet y Firebase con timeout seguro.
 *
 * 1. Chequea `navigator.onLine === false` -> `{ ok: false, motivo: 'SIN_INTERNET' }`
 *    de inmediato sin esperar red.
 * 2. Realiza una lectura real contra el servidor de Firestore (`getDocFromServer`
 *    o `getDoc`) o un `fetchFn` ligero con `Promise.race` de `timeoutMs`.
 *
 * @param {Object} [opciones]
 * @param {Object} [opciones.auth]
 * @param {Object} [opciones.dbFirestore]
 * @param {Function} [opciones.doc]
 * @param {Function} [opciones.getDocFromServer]
 * @param {Function} [opciones.getDoc]
 * @param {Function} [opciones.fetchFn]
 * @param {number} [opciones.timeoutMs=4500]
 * @param {Navigator|null} [opciones.nav]
 * @returns {Promise<{ ok: boolean, motivo: 'SIN_INTERNET'|'SIN_FIREBASE'|null, error?: Error }>}
 */
export async function verificarConectividadFirebase({
    auth = null,
    dbFirestore = null,
    doc = null,
    getDocFromServer = null,
    getDoc = null,
    fetchFn = null,
    timeoutMs = TIMEOUT_FIREBASE_MS,
    nav
} = {}) {
    const navObj = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);

    if (navObj && navObj.onLine === false) {
        return { ok: false, motivo: 'SIN_INTERNET' };
    }

    const lector = getDocFromServer || getDoc;
    const usaFirestore = Boolean(dbFirestore && typeof doc === 'function' && typeof lector === 'function');
    const fnFetch = fetchFn || (typeof fetch === 'function' ? fetch : null);

    if (!usaFirestore && !fnFetch) {
        return { ok: true, motivo: null };
    }

    let timerId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            const err = new Error('TIMEOUT_FIREBASE');
            err.code = 'deadline-exceeded';
            reject(err);
        }, timeoutMs);
    });

    try {
        if (usaFirestore) {
            const uid = auth?.currentUser?.uid || '__ping_conectividad__';
            const ref = doc(dbFirestore, 'finanzas_usuarios', uid);
            await Promise.race([lector(ref), timeoutPromise]);
            return { ok: true, motivo: null };
        }

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const reqPromise = fnFetch('https://firestore.googleapis.com/', {
            method: 'HEAD',
            mode: 'no-cors',
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {})
        });

        try {
            await Promise.race([reqPromise, timeoutPromise]);
            return { ok: true, motivo: null };
        } catch (err) {
            if (controller) {
                try { controller.abort(); } catch (_) {}
            }
            throw err;
        }
    } catch (error) {
        if (errorConfirmaRespuestaServidorFirebase(error)) {
            return { ok: true, motivo: null };
        }
        return { ok: false, motivo: 'SIN_FIREBASE', error };
    } finally {
        if (timerId !== null) {
            clearTimeout(timerId);
        }
    }
}

/**
 * Crea un monitor reactivo del entorno (Internet, Firebase y Batería).
 *
 * @param {Object} [opciones]
 * @param {Function} [opciones.onCambio] Callback invocado cuando cambia el estado
 * @param {Function} [opciones.verificarFirebase] Función async que devuelve `{ ok, motivo }`
 * @param {Navigator|null} [opciones.nav]
 * @param {Window|null} [opciones.win]
 */
export function crearMonitorEntorno({
    onCambio = null,
    verificarFirebase = null,
    nav,
    win
} = {}) {
    const navObj = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);
    const winObj = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);

    let activo = false;
    let batteryManager = null;
    let evaluacionEnCurso = null;

    let estado = {
        bloqueado: false,
        motivo: null,
        detalle: null,
        porcentajeBateria: null
    };

    function emitirSiCambio(nuevoEstado, forzar = false) {
        const cambio =
            forzar ||
            nuevoEstado.bloqueado !== estado.bloqueado ||
            nuevoEstado.motivo !== estado.motivo ||
            nuevoEstado.porcentajeBateria !== estado.porcentajeBateria ||
            nuevoEstado.detalle !== estado.detalle;

        estado = { ...nuevoEstado };
        actualizarEstadoGlobal(estado);

        if (cambio && typeof onCambio === 'function') {
            try {
                onCambio({ ...estado });
            } catch (e) {
                console.warn('[guardias-entorno] Error en onCambio:', e);
            }
        }
    }

    async function evaluar(forzarEmision = false) {
        if (evaluacionEnCurso) {
            return evaluacionEnCurso;
        }

        evaluacionEnCurso = (async () => {
            const resBateria = await evaluarBateria(navObj);
            const porcentajeBateria = resBateria.soportado ? resBateria.porcentaje : null;

            if (navObj && navObj.onLine === false) {
                const nuevo = {
                    bloqueado: true,
                    motivo: 'SIN_INTERNET',
                    detalle: 'Sin conexión a internet.',
                    porcentajeBateria
                };
                emitirSiCambio(nuevo, forzarEmision);
                return { ...estado };
            }

            if (resBateria.soportado && resBateria.bloqueado) {
                const nuevo = {
                    bloqueado: true,
                    motivo: 'BATERIA_BAJA',
                    detalle: `Batería al ${resBateria.porcentaje}% sin cargador conectado.`,
                    porcentajeBateria: resBateria.porcentaje
                };
                emitirSiCambio(nuevo, forzarEmision);
                return { ...estado };
            }

            const chequeoRed = typeof verificarFirebase === 'function'
                ? await verificarFirebase()
                : await verificarConectividadFirebase({ nav: navObj });

            if (!chequeoRed || !chequeoRed.ok) {
                const motivo = chequeoRed?.motivo === 'SIN_INTERNET' ? 'SIN_INTERNET' : 'SIN_FIREBASE';
                const nuevo = {
                    bloqueado: true,
                    motivo,
                    detalle: motivo === 'SIN_INTERNET'
                        ? 'Sin conexión a internet.'
                        : 'No se pudo establecer conexión con Firebase.',
                    porcentajeBateria
                };
                emitirSiCambio(nuevo, forzarEmision);
                return { ...estado };
            }

            const nuevo = {
                bloqueado: false,
                motivo: null,
                detalle: null,
                porcentajeBateria
            };
            emitirSiCambio(nuevo, forzarEmision);
            return { ...estado };
        })();

        try {
            return await evaluacionEnCurso;
        } finally {
            evaluacionEnCurso = null;
        }
    }

    const manejarCambioRed = () => {
        if (!activo) return;
        evaluar();
    };

    const manejarCambioBateria = () => {
        if (!activo) return;
        evaluar();
    };

    async function iniciar() {
        if (!activo) {
            activo = true;
            if (winObj && typeof winObj.addEventListener === 'function') {
                winObj.addEventListener('online', manejarCambioRed);
                winObj.addEventListener('offline', manejarCambioRed);
            }
            if (navObj && typeof navObj.getBattery === 'function') {
                try {
                    batteryManager = await navObj.getBattery();
                    if (batteryManager && typeof batteryManager.addEventListener === 'function') {
                        batteryManager.addEventListener('levelchange', manejarCambioBateria);
                        batteryManager.addEventListener('chargingchange', manejarCambioBateria);
                    }
                } catch (_) {
                    batteryManager = null;
                }
            }
        }
        return evaluar(true);
    }

    function detener() {
        activo = false;
        if (winObj && typeof winObj.removeEventListener === 'function') {
            winObj.removeEventListener('online', manejarCambioRed);
            winObj.removeEventListener('offline', manejarCambioRed);
        }
        if (batteryManager && typeof batteryManager.removeEventListener === 'function') {
            batteryManager.removeEventListener('levelchange', manejarCambioBateria);
            batteryManager.removeEventListener('chargingchange', manejarCambioBateria);
        }
        batteryManager = null;
    }

    async function reintentar() {
        return evaluar(true);
    }

    function obtenerEstado() {
        return { ...estado };
    }

    return {
        iniciar,
        detener,
        reintentar,
        obtenerEstado
    };
}
