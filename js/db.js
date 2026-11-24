/* =========================================================
   MÓDULO DE PERSISTENCIA Y AUTENTICACIÓN FIREBASE (js/db.js)
   ========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getAuth,
    setPersistence,
    browserLocalPersistence,
    signInWithPopup,
    GoogleAuthProvider,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocFromServer, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { busEventos } from "./core/eventos.js";
import { APP_VERSION, SCHEMA_VERSION } from "./version.js";
import { crearBaseVacia, normalizarBase, prepararBase as prepararBaseNucleo, sanitizarParaFirestore } from "./nucleo/base.js";
import {
    baseTieneRegistros,
    crearControlPersistencia,
    evaluarBackupDiario,
    marcarBackupDiarioRealizado
} from "./nucleo/guardias-persistencia.js";
import {
    entornoEstaBloqueado,
    obtenerEstadoEntorno,
    verificarConectividadFirebase
} from "./nucleo/guardias-entorno.js";
import { pintarVersionApp } from "./dom/version-ui.js";
import { cifrarObjeto, descifrarObjeto, esDocumentoCifrado } from "./crypto/nucleo.js";
import { obtenerClaveActiva, estaSesionDesbloqueada, obtenerSaltActivo, establecerClaveActiva, restaurarSesionCriptoDesdeSessionStorage, bloquearSesionCripto } from "./crypto/biometria.js";
import { solicitarDesbloqueoCifrado, prepararDocParaNube } from "./crypto/persistencia.js";
import { generarNombreCopiaRotativa, guardarSnapshotEnHistorial, limpiarHistorialCopias } from "./core/respaldos.js";

/**
 * @deprecated Usar APP_VERSION de js/version.js. Se conserva para no
 * romper imports externos; los valores salen del mismo lugar.
 */
export { APP_VERSION } from "./version.js";
/**
 * @deprecated Usar SCHEMA_VERSION de js/version.js.
 */
export const DB_VERSION = SCHEMA_VERSION;
export { solicitarDesbloqueoCifrado };

const firebaseConfig = {
    apiKey: "AIzaSyA-Seo2AO3STv9YghXE8SiZQ6R8tFS5T2E",
    authDomain: "lineageapp-7039f.firebaseapp.com",
    projectId: "lineageapp-7039f",
    storageBucket: "lineageapp-7039f.firebasestorage.app",
    messagingSenderId: "526969024739",
    appId: "1:526969024739:web:e64f5e1884d3c0d13f95d6"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const dbFirestore = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

export let db = crearBaseVacia();
db.compras = [];
db.comprasCategorias = [];

// Fuente única de verdad para el candado nubeListaParaUid y la guardia anti-borrado
const controlPersistencia = crearControlPersistencia();
const uidsConCifradoConfirmado = new Set();
let secuenciaCargaRemota = 0;

export function estaNubeListaPara(uid) {
    return controlPersistencia.estaNubeListaPara(uid);
}

export function puedeGuardarLocalPara(uid, datos = db) {
    return estaNubeListaPara(uid) && (baseTieneRegistros(datos) || !controlPersistencia.cuentaTeniaDatos(uid));
}

export function marcarCifradoConfirmado(uid) {
    if (typeof uid === 'string' && uid.trim() !== '') {
        uidsConCifradoConfirmado.add(uid.trim());
    }
}

export function tieneCifradoActivoLocal(uid) {
    if (!uid) return false;
    if (uidsConCifradoConfirmado.has(uid)) return true;
    if (typeof localStorage === 'undefined') return false;
    try {
        return Boolean(
            localStorage.getItem(`cero_conocimiento_activo_${uid}`) === 'true' ||
            localStorage.getItem(`cero_conocimiento_salt_${uid}`)
        );
    } catch (_) {
        return false;
    }
}

function clonarObjetoSeguro(datos) {
    if (datos === null || typeof datos !== 'object') return datos;
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(datos);
        }
    } catch (_) {}
    return JSON.parse(JSON.stringify(datos));
}

function limpiarClavesComprasLocales(uid = null) {
    if (typeof localStorage === 'undefined') return;
    try {
        if (uid) {
            localStorage.removeItem(`compras_lineage_${uid}`);
            localStorage.removeItem(`compras_cats_compras_lineage_${uid}`);
        }
        localStorage.removeItem('compras_lineage_anon');
        localStorage.removeItem('compras_cats_compras_lineage_anon');
    } catch (_) {}
}

function reiniciarDbEnMemoria() {
    Object.keys(db).forEach((k) => delete db[k]);
    Object.assign(db, crearBaseVacia(), { compras: [], comprasCategorias: [] });
}

function reemplazarDbEnMemoria(nuevaBase) {
    Object.keys(db).forEach((k) => delete db[k]);
    Object.assign(db, nuevaBase);
    db.compras = Array.isArray(db.compras) ? db.compras : [];
    db.comprasCategorias = Array.isArray(db.comprasCategorias) ? db.comprasCategorias : [];
}

/**
 * Normaliza la FORMA de los datos.
 *
 * Adaptador delgado sobre `normalizarBase` (js/nucleo/base.js). La
 * lógica vive allá para poder testearla: este módulo importa
 * Firebase por URL HTTPS y Node no puede cargarlo.
 *
 * Lo que garantiza: que existan `ingresos`, `gastos`, `deseos` y
 * `pasivos` con el tipo correcto, y que `dolar` sea número. Un
 * documento de Firestore de una versión vieja puede no tener
 * `deseos`; sin esto, el render de deseos revienta la app.
 *
 * Lo que NO hace, a propósito: NO fija `version`. Antes lo hacía,
 * con lo que una base en versión 12 quedaba estampada como 13 sin
 * pasar por ninguna migración. Ahora preserva la versión declarada
 * para que `aplicarMigraciones` pueda hacer su trabajo.
 *
 * @param {*} data Datos sin procesar
 * @returns {Object} Base normalizada (objeto nuevo)
 */
export function migrarDb(data) {
    return normalizarBase(data, db);
}

/**
 * Punto de entrada único para preparar datos que entran a la app:
 * normaliza la forma y luego aplica las migraciones pendientes.
 *
 * Existe porque hasta ahora cada llamador hacía una cosa distinta:
 * el import de JSON pasaba por `migrarDb` y la carga de Firestore no
 * pasaba por nada. Por eso un documento remoto con la forma
 * incompleta rompía la app mientras el mismo respaldo en un
 * archivo funcionaba bien.
 *
 * @param {*} data Datos sin procesar
 * @returns {{base:Object, migracionesAplicadas:number[]}}
 */
export function prepararBase(data) {
    return prepararBaseNucleo(data, db);
}

function textoError(error) {
    if (!error) return 'sin error';
    if (typeof error === 'string') return error;
    return `${error.code || error.name || 'Error'}: ${error.message || error}`;
}

export function generarJsonSnapshot(data) {
    try {
        return JSON.stringify(data ?? {}, null, 2);
    } catch (e) {
        console.warn('[db] generarJsonSnapshot error:', e);
        return '{}';
    }
}

export function descargarJson(data = db, nombre = null) {
    try {
        const uid = auth?.currentUser?.uid || null;
        const storage = typeof localStorage !== 'undefined' ? localStorage : null;
        const esNombrePorDefecto = !nombre || nombre === 'control_financiero_snapshot.json' || nombre.startsWith('cf_');
        const nombreFinal = esNombrePorDefecto ? generarNombreCopiaRotativa(null, storage, uid) : nombre;
        if (!tieneCifradoActivoLocal(uid)) {
            guardarSnapshotEnHistorial(data, storage, uid);
        }

        const txt = generarJsonSnapshot(data);
        const blob = new Blob([txt], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombreFinal;
        document.body.appendChild(a);
        a.click();
        // Revocar el objeto URL de inmediato (setTimeout 0)
        // cancela la descarga en varios navegadores: el blob
        // se destruye antes de que el navegador termine de
        // leerlo y el archivo no se genera. Se deja un
        // margen amplio y se limpia después, con todo
        // protegido para que un fallo de limpieza nunca
        // rompa la descarga.
        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
                a.remove();
            } catch (_) {}
        }, 4000);
    } catch (e) {
        console.warn('[db] descargarJson error:', e);
    }
}

export function mostrarDebug(mensaje, error = null) {
    const detalle = error ? `${mensaje}\n${textoError(error)}` : mensaje;
    if (error) {
        console.error('[LineageApp]', detalle, error);
    } else {
        console.log('[LineageApp]', detalle);
    }
    const debug = document.getElementById('login-debug');
    if (debug && error) {
        debug.textContent = detalle;
        debug.classList.remove('hidden');
    }
}

function actualizarEstadoApp(mensaje) {
    const estado = document.getElementById('debug-app-status');
    if (estado) estado.textContent = mensaje;
}

/**
 * Reexporta el pintado de versión para no cambiar los imports de
 * quien ya lo venía usando desde acá.
 *
 * La lógica vive en js/dom/version-ui.js: este módulo importa
 * Firebase por URL HTTPS y Node no puede cargarlo, así que lo que
 * quedara adentro sería intestable.
 */
export { pintarVersionApp } from "./dom/version-ui.js";

function crearPanelLogin() {
    // Se pinta antes del early return: la etiqueta vive dentro del
    // panel, pero el encabezado existe siempre.
    pintarVersionApp();

    const panel = document.getElementById('login-panel');
    if (!panel) return;

    const boton = panel.querySelector('#login-google-button');
    if (boton && boton.dataset.authListenerAttached !== 'true') {
        boton.addEventListener('click', () => {
            if (typeof window.iniciarSesionGoogle === 'function') {
                window.iniciarSesionGoogle();
            } else {
                iniciarSesionGoogle();
            }
        });
        boton.dataset.authListenerAttached = 'true';
    }
}

function actualizarPanelLogin(user) {
    crearPanelLogin();
    const panel = document.getElementById('login-panel');
    const mainApp = document.getElementById('app-content');
    if (panel) panel.classList.toggle('hidden', Boolean(user));
    if (mainApp) mainApp.classList.toggle('hidden', !Boolean(user));
    actualizarEstadoApp(user ? 'Usuario autenticado. Cargando datos…' : 'Esperando inicio de sesión…');
    const debug = document.getElementById('login-debug');
    if (debug && !user) debug.classList.add('hidden');
}

const persistenceReady = setPersistence(auth, browserLocalPersistence).catch((error) => {
    mostrarDebug('No se pudo conservar la sesión', error);
    actualizarEstadoApp('No se pudo configurar la sesión.');
    throw error;
});

let authStateReadyResolved = false;
const authStateReady = persistenceReady.then(() => new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
        const uidListo = controlPersistencia.obtenerNubeListaParaUid();
        if (!user || (uidListo && user.uid !== uidListo)) {
            secuenciaCargaRemota++;
            controlPersistencia.resetear();
        }
        actualizarPanelLogin(user);
        if (!authStateReadyResolved) {
            authStateReadyResolved = true;
            resolve(user);
        }
        busEventos.emitir('auth:cambio', { user });
    }, (error) => {
        mostrarDebug('Falló la observación de autenticación', error);
        actualizarEstadoApp('Error restaurando la sesión.');
        if (!authStateReadyResolved) {
            authStateReadyResolved = true;
            reject(error);
        }
    });
}));

export async function iniciarSesionGoogle() {
    mostrarDebug('Iniciando autenticación con Google...');
    try {
        await persistenceReady;
        const result = await signInWithPopup(auth, provider);
        return result?.user || auth.currentUser;
    } catch (error) {
        mostrarDebug('Falló el inicio de sesión', error);
        if (error.code === 'auth/unauthorized-domain') alert('Este dominio no está autorizado en Firebase Authentication.');
        else if (error.code === 'auth/operation-not-allowed') alert('El proveedor de Google no está habilitado en Firebase.');
        else if (error.code !== 'auth/popup-closed-by-user') alert(`No se pudo iniciar sesión.\nCódigo: ${error.code || 'unknown'}`);
        throw error;
    }
}

export function cerrarSesion() {
    secuenciaCargaRemota++;
    const uid = auth.currentUser?.uid || null;
    const tieneCifradoActivo = tieneCifradoActivoLocal(uid);

    try {
        if (typeof localStorage !== 'undefined') {
            // Limpieza defensiva de residuos históricos compartidos
            localStorage.removeItem('finanzas_db_fallback');
            if (tieneCifradoActivo) {
                // Prevenir fuga de datos financieros sin cifrar en reposo
                if (uid) {
                    localStorage.removeItem(`finanzas_db_${uid}`);
                }
                limpiarClavesComprasLocales(uid);
                limpiarHistorialCopias(uid, localStorage);
            } else {
                limpiarClavesComprasLocales(null);
                if (uid && puedeGuardarLocalPara(uid, db)) {
                    const ahora = Date.now();
                    localStorage.setItem(`finanzas_db_${uid}`, JSON.stringify({ db, timestamp: ahora }));
                }
            }
        }
    } catch (e) {
        console.warn('[db] Error gestionando copia local al cerrar sesión:', e);
    }

    // Destruir sesión criptográfica, limpiar memoria en caliente y resetear candados de persistencia
    bloquearSesionCripto(uid);
    reiniciarDbEnMemoria();
    controlPersistencia.resetear();

    return signOut(auth).then(() => {
        if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
            window.location.reload();
        }
    });
}
window.cerrarSesion = cerrarSesion;

export async function esperarUsuario() {
    await persistenceReady;
    if (auth.currentUser) return auth.currentUser;
    return authStateReady;
}

/* =========================================================
   CONTRATO DE EVENTOS DE PERSISTENCIA
   =========================================================
   db.js no muestra avisos: emite hechos y deja que app.js
   decida si ameritan un toast. Motivos válidos de 'motivo':
     'auto'          guardado por intervalo (cada 15 min)
     'edicion'       el usuario agregó/editó/borró un registro
     'manual'        apretó el botón Guardar
     'importacion'   restauró un respaldo JSON

   Regla de presentación: los guardados automáticos NO se
   anuncian. Pasaría un toast cada 15 minutos sin que nadie lo
   pidiera. Los manuales y los errores, sí.
   ========================================================= */

/**
 * Emite un error de persistencia con el detalle ya formateado.
 * @private
 */
function reportarFalloPersistencia(operacion, motivo, error) {
    busEventos.emitir('db:error', {
        operacion,
        motivo,
        error,
        mensaje: textoError(error),
        // Si la copia local quedó escrita, el usuario puede
        // reintentar más tarde sin perder nada.
        recuperable: true
    });
}

/**
 * Escribe la base en Firestore sanitizando los datos o cifrándolos
 * con Cero Conocimiento si existe una sesión criptográfica activa.
 *
 * Si el usuario desbloqueó la sesión con su PIN o biometría:
 * genera el sobre cifrado AES-GCM 256 bits y almacena exclusivamente:
 * { esCifrado: true, versionCifrado: 1, salt, iv, datos, timestamp }.
 *
 * Si no tiene cifrado activado:
 * almacena el documento estándar en texto plano sanitizado,
 * manteniendo retrocompatibilidad total con cuentas existentes.
 *
 * @param {string} uid
 * @param {Object} datos
 * @returns {Promise<void>}
 */
export async function verificarConexionFirebase(timeoutMs = 4500) {
    return verificarConectividadFirebase({
        auth,
        dbFirestore,
        doc,
        getDocFromServer,
        timeoutMs
    });
}

export async function escribirEnNube(uid, datos, opciones = {}) {
    if (entornoEstaBloqueado()) {
        const estadoEntorno = obtenerEstadoEntorno();
        const motivoEntorno = estadoEntorno.motivo || 'SIN_INTERNET';
        console.warn('[Seguridad] Escritura remota abortada: entorno bloqueado ->', motivoEntorno);
        return { ok: false, bloqueado: true, motivo: motivoEntorno };
    }

    // Candado 1 (nubeListaParaUid) y Candado 2 (Guardia anti-borrado)
    const validacion = controlPersistencia.validarEscrituraRemota(uid, datos);
    if (!validacion.permitido) {
        if (validacion.motivo === 'NUBE_NO_LISTA') {
            console.warn('[Seguridad] Escritura remota abortada: la carga remota aún no finalizó para este usuario.');
            return { ok: false, bloqueado: true, motivo: 'NUBE_NO_LISTA' };
        }
        if (validacion.motivo === 'BLOQUEO_ANTI_BORRADO') {
            const errBloqueo = new Error('BLOQUEO_ANTI_BORRADO');
            console.error('[Seguridad] Escritura remota bloqueada: intento de sobrescribir una cuenta con datos usando una base vacía.');
            busEventos.emitir('db:error', {
                operacion: 'guardar',
                motivo: 'anti-borrado',
                error: errBloqueo,
                mensaje: validacion.mensaje,
                recuperable: true
            });
            return { ok: false, bloqueado: true, motivo: 'BLOQUEO_ANTI_BORRADO', error: errBloqueo };
        }
    }

    // Candado 3 (Cero Conocimiento): nunca escribir en texto plano si la sesión está bloqueada
    const tieneCifradoConfigurado = tieneCifradoActivoLocal(uid);
    const sesionDesbloqueada = estaSesionDesbloqueada() && obtenerClaveActiva();

    if (tieneCifradoConfigurado && !sesionDesbloqueada) {
        console.warn('[Seguridad] Escritura remota abortada: la sesión criptográfica está bloqueada para este usuario.');
        return { ok: false, bloqueado: true, motivo: 'SESION_BLOQUEADA' };
    }

    // Snapshot inmutable síncrono antes del primer await para evitar carreras con reiniciarDbEnMemoria()
    const snapshotInmutable = clonarObjetoSeguro(datos);

    const docParaGuardar = await prepararDocParaNube(snapshotInmutable, uid, opciones);
    if (!docParaGuardar) {
        const motivoBloqueo = tieneCifradoActivoLocal(uid) ? 'SESION_BLOQUEADA' : 'SIN_DOCUMENTO';
        return { ok: false, bloqueado: true, motivo: motivoBloqueo };
    }

    await setDoc(doc(dbFirestore, 'finanzas_usuarios', uid), docParaGuardar);
    controlPersistencia.registrarDatosConfirmados(uid, snapshotInmutable);

    // Backup diario rotativo de 7 días (dia_0..dia_6), preservando el sobre cifrado
    try {
        const storage = typeof localStorage !== 'undefined' ? localStorage : null;
        const planBackup = evaluarBackupDiario(uid, snapshotInmutable, storage);
        if (planBackup.debeEscribir) {
            await setDoc(
                doc(dbFirestore, 'finanzas_usuarios', uid, 'backups', planBackup.slotId),
                docParaGuardar
            );
            marcarBackupDiarioRealizado(uid, planBackup.fechaStr, storage);
        }
    } catch (errBackup) {
        console.warn('[Backup] No se pudo escribir el backup diario en Firestore (guardado principal intacto):', errBackup);
    }

    return { ok: true };
}

export async function cargarBaseDatosRemota(usuario = null, opciones = {}) {
    const miSecuencia = ++secuenciaCargaRemota;
    const forzarDesdeNube = Boolean(opciones?.forzarDesdeNube);

    const user = usuario || await esperarUsuario();
    if (miSecuencia !== secuenciaCargaRemota) {
        return { user: null, database: null, obsoleta: true };
    }
    if (!user) {
        controlPersistencia.resetear();
        actualizarEstadoApp('Sesión no iniciada.');
        return { user: null, database: null };
    }

    const sigueVigente = () => miSecuencia === secuenciaCargaRemota && auth.currentUser?.uid === user.uid;

    // Mantener candado cerrado hasta confirmar lectura y descifrado exitosos para este uid
    if (!controlPersistencia.estaNubeListaPara(user.uid)) {
        controlPersistencia.resetear();
    }

    actualizarEstadoApp('Cargando datos de Firestore…');
    busEventos.emitir('db:cargando', { operacion: 'cargar', motivo: 'arranque' });

    // 1. Leer copia local EXCLUSIVAMENTE del usuario autenticado (y jamás si tiene Cero Conocimiento activo)
    let localData = null;
    let localTimestamp = 0;
    if (!tieneCifradoActivoLocal(user.uid)) {
        try {
            const rawLocalUser = typeof localStorage !== 'undefined' ? localStorage.getItem(`finanzas_db_${user.uid}`) : null;
            if (rawLocalUser) {
                const parsed = JSON.parse(rawLocalUser);
                if (parsed && typeof parsed === 'object') {
                    if (parsed.db) {
                        localData = parsed.db;
                        localTimestamp = Number(parsed.timestamp) || 0;
                    } else {
                        localData = parsed;
                        localTimestamp = Number(parsed.timestamp) || 0;
                    }
                }
            }
        } catch (e) {
            console.warn('[db] No se pudo leer la copia local previa:', e);
        }
    }

    const docRef = doc(dbFirestore, 'finanzas_usuarios', user.uid);
    try {
        const snap = await getDoc(docRef);
        if (!sigueVigente()) {
            return { user: null, database: null, obsoleta: true };
        }

        if (snap.exists()) {
            const rawData = snap.data();
            let remoteData = rawData;

            if (esDocumentoCifrado(rawData)) {
                marcarCifradoConfirmado(user.uid);
                localData = null;
                localTimestamp = 0;
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.removeItem(`finanzas_db_${user.uid}`);
                    }
                } catch (_) {}

                if (!estaSesionDesbloqueada()) {
                    await restaurarSesionCriptoDesdeSessionStorage(user?.uid);
                    if (!sigueVigente()) {
                        return { user: null, database: null, obsoleta: true };
                    }
                }
                if (estaSesionDesbloqueada() && obtenerClaveActiva()) {
                    remoteData = await descifrarObjeto(rawData, obtenerClaveActiva());
                } else {
                    const solicitar = (typeof window !== 'undefined' && typeof window.solicitarDesbloqueoCifrado === 'function')
                        ? window.solicitarDesbloqueoCifrado
                        : solicitarDesbloqueoCifrado;
                    remoteData = await solicitar(rawData, user);
                }
                if (!sigueVigente()) {
                    return { user: null, database: null, obsoleta: true };
                }

                if (rawData.salt && user?.uid && typeof localStorage !== 'undefined') {
                    try {
                        localStorage.setItem(`cero_conocimiento_salt_${user.uid}`, rawData.salt);
                        localStorage.setItem(`cero_conocimiento_activo_${user.uid}`, 'true');
                    } catch (_) {}
                }
            }

            const remoteTimestamp = Number(remoteData?.timestamp || rawData?.timestamp) || 0;
            const nubeTeniaDatos = baseTieneRegistros(remoteData);

            // Si la versión local es más reciente que la remota (guardado offline o inactividad),
            // solo se promueve si no se pidió forzarDesdeNube, no hay cifrado activo y no pisa una nube con datos usando una copia vacía.
            if (
                !forzarDesdeNube &&
                !tieneCifradoActivoLocal(user.uid) &&
                localData &&
                localTimestamp > 0 &&
                remoteTimestamp > 0 &&
                localTimestamp > remoteTimestamp &&
                (!nubeTeniaDatos || baseTieneRegistros(localData))
            ) {
                console.info('[db] La versión local es más reciente que la nube. Usando versión local y sincronizando nube.');
                const { base } = prepararBase(localData);
                reemplazarDbEnMemoria(base);
                db.timestamp = localTimestamp;
                controlPersistencia.marcarNubeLista(user.uid, db, { teniaDatos: nubeTeniaDatos });
                try {
                    await escribirEnNube(user.uid, db);
                } catch (errSync) {
                    console.warn('[db] Error al re-sincronizar nube con versión local más reciente:', errSync);
                }
                if (!sigueVigente()) {
                    return { user: null, database: null, obsoleta: true };
                }
            } else {
                const { base, migracionesAplicadas } = prepararBase(remoteData);
                if (migracionesAplicadas.length > 0) {
                    console.info(`[Esquema] Migraciones aplicadas: ${migracionesAplicadas.join(', ')}`);
                }
                reemplazarDbEnMemoria(base);
                if (remoteTimestamp > 0) db.timestamp = remoteTimestamp;
                controlPersistencia.marcarNubeLista(user.uid, db, { teniaDatos: nubeTeniaDatos });
            }

            try {
                if (typeof localStorage !== 'undefined' && !tieneCifradoActivoLocal(user.uid)) {
                    const ahora = db.timestamp || Date.now();
                    localStorage.setItem(`finanzas_db_${user.uid}`, JSON.stringify({ db, timestamp: ahora }));
                }
            } catch (e) {
                console.warn('[db] No se pudo respaldar copia local tras carga de nube:', e);
            }
        } else {
            // Primera apertura de la cuenta: el documento remoto no existe.
            reiniciarDbEnMemoria();
            if (localData && !forzarDesdeNube && !tieneCifradoActivoLocal(user.uid)) {
                try {
                    const { base: baseLocal } = prepararBaseNucleo(localData, db);
                    reemplazarDbEnMemoria(baseLocal);
                    console.info('[db] Documento remoto inexistente: se sembró desde la copia local del usuario.');
                } catch (e) {
                    console.warn('[db] No se pudo leer la copia local para sembrar:', e);
                }
            }
            db.timestamp = db.timestamp || Date.now();
            controlPersistencia.marcarNubeLista(user.uid, db);
            await escribirEnNube(user.uid, db);
            if (!sigueVigente()) {
                return { user: null, database: null, obsoleta: true };
            }
            try {
                if (typeof localStorage !== 'undefined' && !tieneCifradoActivoLocal(user.uid)) {
                    const ahora = db.timestamp || Date.now();
                    localStorage.setItem(`finanzas_db_${user.uid}`, JSON.stringify({ db, timestamp: ahora }));
                }
            } catch (_) {}
        }
        actualizarEstadoApp('Aplicación lista');
        busEventos.emitir('db:cargado', { operacion: 'cargar', motivo: 'arranque', destino: 'nube', vacio: !snap.exists() });
        return { user, database: db, vacio: !snap.exists() };
    } catch (error) {
        controlPersistencia.resetear();
        if (!sigueVigente()) {
            return { user: null, database: null, obsoleta: true };
        }
        if (error?.message === 'DESBLOQUEO_CANCELADO') {
            actualizarEstadoApp('Desbloqueo cancelado.');
            return { user: null, database: null, cancelado: true, error };
        }
        mostrarDebug('Falló la carga de datos de Firestore', error);
        if (!tieneCifradoActivoLocal(user.uid) && localData) {
            actualizarEstadoApp('No se pudieron cargar los datos de la nube. Usando respaldo local.');
            try {
                const { base: baseLocal } = prepararBase(localData);
                reemplazarDbEnMemoria(baseLocal);
                console.info('[db] Respaldo local del usuario restaurado tras error de red.');
            } catch (e) {
                console.warn('[db] Error restaurando copia local tras fallo de red:', e);
            }
        } else {
            actualizarEstadoApp('No se pudieron cargar los datos de la nube.');
        }
        reportarFalloPersistencia('cargar', 'arranque', error);
        busEventos.emitir('db:cargado', { operacion: 'cargar', motivo: 'arranque', destino: 'local', error });
        return { user, database: db, error, origen: 'local' };
    }
}

export async function guardarBaseDatosLocal(data, motivo = 'edicion') {
    if (!data || typeof data !== 'object') {
        return { ok: false, destino: 'local', motivo: 'datos-invalidos' };
    }
    reemplazarDbEnMemoria(data);
    db.version = SCHEMA_VERSION;
    const ahora = Date.now();
    db.timestamp = ahora;
    if (!Array.isArray(db.compras)) db.compras = [];
    if (!Array.isArray(db.comprasCategorias)) db.comprasCategorias = [];
    try {
        const uidActual = auth.currentUser?.uid;
        if (
            uidActual &&
            typeof localStorage !== 'undefined' &&
            !tieneCifradoActivoLocal(uidActual) &&
            puedeGuardarLocalPara(uidActual, db)
        ) {
            localStorage.setItem(`finanzas_db_${auth.currentUser.uid}`, JSON.stringify({ db, timestamp: ahora }));
        }
    } catch (e) {
        console.warn('[db] No se pudo escribir la copia local:', e);
    }
    busEventos.emitir('db:cargado', { operacion: 'guardar-local', motivo, destino: 'local' });

    if (auth.currentUser) {
        try {
            const resNube = await escribirEnNube(auth.currentUser.uid, db);
            if (resNube && resNube.bloqueado) {
                if (resNube.motivo === 'NUBE_NO_LISTA') {
                    if (motivo === 'manual') {
                        busEventos.emitir('db:error', {
                            operacion: 'guardar-local',
                            motivo: 'nube-no-lista',
                            mensaje: 'Todavía no se completó la carga desde la nube. Esperá un instante o sincronizá antes de guardar.',
                            recuperable: true
                        });
                    }
                    return { ok: false, destino: 'local', motivo: 'nube-no-lista' };
                }
                if (resNube.motivo === 'SESION_BLOQUEADA') {
                    if (motivo === 'manual') {
                        busEventos.emitir('db:error', {
                            operacion: 'guardar-local',
                            motivo: 'sesion-bloqueada',
                            mensaje: 'Tu sesión cifrada está bloqueada. Desbloqueala con tu PIN o biometría para guardar en la nube.',
                            recuperable: true
                        });
                    }
                    return { ok: false, destino: 'local', motivo: 'sesion-bloqueada' };
                }
                if (resNube.motivo === 'BLOQUEO_ANTI_BORRADO') {
                    return { ok: false, destino: 'local', motivo: 'anti-borrado', error: resNube.error };
                }
                return { ok: false, destino: 'local', motivo: 'bloqueado' };
            }
            busEventos.emitir('db:cargado', { operacion: 'guardar-local', motivo, destino: 'nube' });
            return { ok: true, destino: 'nube' };
        } catch (error) {
            mostrarDebug('Falló el guardado en Firestore', error);
            reportarFalloPersistencia('guardar-local', motivo, error);
            return { ok: false, destino: 'local', error };
        }
    }
    return { ok: true, destino: 'local' };
}

/**
 * Guarda la base completa en localStorage (aislado por uid) y en Firestore.
 *
 * El parámetro `motivo` es nuevo y opcional: los llamadores
 * existentes que invocan guardarTodo() siguen funcionando sin
 * cambios y se comportan como 'auto'.
 *
 * @param {string} [motivo]
 * @returns {Promise<{ok:boolean, destino:string, motivo?:string, error?:Error}>}
 */
export async function guardarTodo(motivo = 'auto') {
    if (entornoEstaBloqueado()) {
        const estadoEntorno = obtenerEstadoEntorno();
        const motivoBloqueo = estadoEntorno.motivo || 'SIN_INTERNET';
        if (motivo === 'manual') {
            busEventos.emitir('db:error', {
                operacion: 'guardar',
                motivo: motivoBloqueo === 'BATERIA_BAJA' ? 'bateria-baja' : 'sin-conexion',
                mensaje: motivoBloqueo === 'BATERIA_BAJA'
                    ? 'Batería baja (< 15%): conectá el cargador para guardar de forma segura.'
                    : 'Sin conexión a internet o Firebase. Reintentá la conexión antes de guardar.',
                recuperable: true
            });
        }
        return { ok: false, bloqueado: true, motivo: motivoBloqueo };
    }

    db.version = SCHEMA_VERSION;
    const ahora = Date.now();
    db.timestamp = ahora;
    if (!Array.isArray(db.compras)) db.compras = [];
    if (!Array.isArray(db.comprasCategorias)) db.comprasCategorias = [];
    try {
        const uidActual = auth.currentUser?.uid;
        if (
            uidActual &&
            typeof localStorage !== 'undefined' &&
            !tieneCifradoActivoLocal(uidActual) &&
            puedeGuardarLocalPara(uidActual, db)
        ) {
            localStorage.setItem(`finanzas_db_${auth.currentUser.uid}`, JSON.stringify({ db, timestamp: ahora }));
        }
    } catch (e) {
        console.warn('[db] No se pudo escribir la copia local:', e);
    }
    busEventos.emitir('db:cargado', { operacion: 'guardar', motivo, destino: 'local' });

    if (!auth.currentUser || !navigator.onLine) {
        // Sin sesión o sin red no es un fallo: la copia local está
        // escrita y se subirá en el próximo guardado con red.
        return { ok: true, destino: 'local', motivo: auth.currentUser ? 'sin-conexion' : 'sin-sesion' };
    }

    try {
        const resNube = await escribirEnNube(auth.currentUser.uid, db);
        if (resNube && resNube.bloqueado) {
            if (resNube.motivo === 'NUBE_NO_LISTA') {
                if (motivo === 'manual') {
                    busEventos.emitir('db:error', {
                        operacion: 'guardar',
                        motivo: 'nube-no-lista',
                        mensaje: 'Todavía no se completó la carga desde la nube. Esperá un instante o sincronizá antes de guardar.',
                        recuperable: true
                    });
                }
                return { ok: false, destino: 'local', motivo: 'nube-no-lista' };
            }
            if (resNube.motivo === 'SESION_BLOQUEADA') {
                if (motivo === 'manual') {
                    busEventos.emitir('db:error', {
                        operacion: 'guardar',
                        motivo: 'sesion-bloqueada',
                        mensaje: 'Tu sesión cifrada está bloqueada. Desbloqueala con tu PIN o biometría para guardar en la nube.',
                        recuperable: true
                    });
                }
                return { ok: false, destino: 'local', motivo: 'sesion-bloqueada' };
            }
            if (resNube.motivo === 'BLOQUEO_ANTI_BORRADO') {
                return { ok: false, destino: 'local', motivo: 'anti-borrado', error: resNube.error };
            }
            return { ok: false, destino: 'local', motivo: 'bloqueado' };
        }
        console.log('[Guardado] Nube + Local');
        busEventos.emitir('db:cargado', { operacion: 'guardar', motivo, destino: 'nube' });
        return { ok: true, destino: 'nube' };
    } catch (error) {
        // Antes esto era un console.warn y nada más: el usuario
        // seguía creyendo que sus cambios estaban en la nube. Se
        // conserva la traza para diagnóstico y además se emite el
        // evento, que es lo que permite avisarle sin bloquear.
        console.warn('[Guardado] Solo local (sin conexión):', error);
        reportarFalloPersistencia('guardar', motivo, error);
        return { ok: false, destino: 'local', error };
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', crearPanelLogin, { once: true });
} else {
    crearPanelLogin();
}

/* Red de seguridad: si el listener de arriba corrió antes de que
   existiera el encabezado (o si initApp reemplaza el header), el
   número vuelve a escribirse en la primera pintura. Es idempotente,
   así que repetirlo no hace daño. */
if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => pintarVersionApp());
}

/* =========================================================
   GUARDADO AUTOMÁTICO
   =========================================================
   Ya no hay intervalo acá. El autoguardado periódico vive
   en js/core/inactividad.js (iniciarAutoguardado, cada
   15 minutos) porque además de la nube genera el JSON y
   re-renderiza; un intervalo acá sólo guardaba la nube,
   no generaba el JSON y no se podía detener al cerrar
   sesión. Duplicarlo hubiera significado dos guardados
   distintos compitiendo cada pocos minutos.
   ========================================================= */
