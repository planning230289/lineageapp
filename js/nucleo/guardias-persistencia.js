/* =========================================================
   GUARDIAS DE PERSISTENCIA Y BACKUPS ROTATIVOS
   (js/nucleo/guardias-persistencia.js)
   =========================================================
   Módulo puro (sin Firebase ni DOM) que concentra las reglas
   de seguridad para la sincronización con Firestore:

     1. Detección de contenido real en la base (baseTieneRegistros)
     2. Candado de carga remota por UID (nubeListaParaUid)
     3. Guardia anti-borrado accidental de cuentas con datos
     4. Cálculo y control de backups diarios rotativos (7 días)
   ========================================================= */

/**
 * Verifica si un mapa indexado por mes (`{ 'YYYY-MM': [...] }`)
 * contiene al menos un arreglo con un elemento.
 *
 * @param {*} mapa
 * @returns {boolean}
 */
function mapaMesesTieneRegistros(mapa) {
    if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) {
        return false;
    }
    for (const lista of Object.values(mapa)) {
        if (Array.isArray(lista) && lista.length > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Determina si una base de datos contiene al menos un registro real
 * en cualquiera de sus colecciones principales:
 * ingresos, gastos, deseos, pasivos o compras.
 *
 * Retorna `false` ante `null`, `undefined`, objetos vacíos o
 * estructuras malformadas.
 *
 * @param {*} datos
 * @returns {boolean}
 */
export function baseTieneRegistros(datos) {
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
        return false;
    }

    if (mapaMesesTieneRegistros(datos.ingresos)) return true;
    if (mapaMesesTieneRegistros(datos.gastos)) return true;
    if (Array.isArray(datos.deseos) && datos.deseos.length > 0) return true;
    if (Array.isArray(datos.pasivos) && datos.pasivos.length > 0) return true;
    if (Array.isArray(datos.compras) && datos.compras.length > 0) return true;

    return false;
}

/**
 * Crea un controlador de estado de persistencia remota aislado.
 *
 * Mantiene dos candados coordinados por `uid`:
 *   - `nubeListaParaUid`: impide escribir en Firestore hasta confirmar
 *     una lectura y descifrado exitosos para ese mismo usuario.
 *   - `cuentaTeniaDatosParaUid`: impide sobrescribir con una base vacía
 *     una cuenta que ya tenía registros confirmados.
 */
export function crearControlPersistencia() {
    let nubeListaParaUid = null;
    let cuentaTeniaDatosParaUid = false;

    function obtenerNubeListaParaUid() {
        return nubeListaParaUid;
    }

    function estaNubeListaPara(uid) {
        return Boolean(uid) && nubeListaParaUid === uid;
    }

    function cuentaTeniaDatos(uid) {
        return Boolean(uid) && nubeListaParaUid === uid && cuentaTeniaDatosParaUid;
    }

    /**
     * Marca la nube como lista para `uid` y registra si la cuenta
     * ya contenía datos reales.
     *
     * @param {string} uid
     * @param {Object} datos
     * @param {{ teniaDatos?: boolean }} [opciones]
     */
    function marcarNubeLista(uid, datos, opciones = {}) {
        if (!uid) {
            resetear();
            return;
        }
        nubeListaParaUid = uid;
        cuentaTeniaDatosParaUid = Boolean(opciones?.teniaDatos) || baseTieneRegistros(datos);
    }

    /**
     * Si la cuenta ya está lista para `uid` y ahora tiene registros reales,
     * activa la protección anti-borrado para el resto de la sesión.
     *
     * @param {string} uid
     * @param {Object} datos
     */
    function registrarDatosConfirmados(uid, datos) {
        if (Boolean(uid) && nubeListaParaUid === uid && baseTieneRegistros(datos)) {
            cuentaTeniaDatosParaUid = true;
        }
    }

    function resetear() {
        nubeListaParaUid = null;
        cuentaTeniaDatosParaUid = false;
    }

    /**
     * Evalúa si una escritura remota para `uid` está autorizada.
     *
     * @param {string} uid
     * @param {Object} datos
     * @returns {{ permitido: true } | { permitido: false, motivo: 'NUBE_NO_LISTA'|'BLOQUEO_ANTI_BORRADO', mensaje: string }}
     */
    function validarEscrituraRemota(uid, datos) {
        if (!uid || nubeListaParaUid !== uid) {
            return {
                permitido: false,
                motivo: 'NUBE_NO_LISTA',
                mensaje: 'La carga remota aún no finalizó para este usuario.'
            };
        }

        if (cuentaTeniaDatosParaUid && !baseTieneRegistros(datos)) {
            return {
                permitido: false,
                motivo: 'BLOQUEO_ANTI_BORRADO',
                mensaje: 'Se bloqueó la escritura de una base vacía para proteger tus datos en la nube.'
            };
        }

        return { permitido: true };
    }

    return {
        obtenerNubeListaParaUid,
        estaNubeListaPara,
        cuentaTeniaDatos,
        marcarNubeLista,
        registrarDatosConfirmados,
        resetear,
        validarEscrituraRemota
    };
}

/**
 * Convierte una fecha a formato local `'YYYY-MM-DD'`.
 *
 * @param {Date} [fecha=new Date()]
 * @returns {string}
 */
export function obtenerFechaLocalYYYYMMDD(fecha = new Date()) {
    const f = (fecha instanceof Date && !Number.isNaN(fecha.getTime())) ? fecha : new Date();
    const anio = f.getFullYear();
    const mes = String(f.getMonth() + 1).padStart(2, '0');
    const dia = String(f.getDate()).padStart(2, '0');
    return `${anio}-${mes}-${dia}`;
}

/**
 * Devuelve el identificador del slot semanal rotativo en hora local
 * (`dia_0` domingo a `dia_6` sábado).
 *
 * @param {Date} [fecha=new Date()]
 * @returns {string}
 */
export function obtenerSlotBackupSemanal(fecha = new Date()) {
    const f = (fecha instanceof Date && !Number.isNaN(fecha.getTime())) ? fecha : new Date();
    return `dia_${f.getDay()}`;
}

/**
 * Clave en localStorage que registra el último día con backup remoto para `uid`.
 *
 * @param {string} uid
 * @returns {string}
 */
export function obtenerClaveUltimoBackup(uid) {
    return uid ? `ultimo_backup_nube_${uid}` : '';
}

/**
 * Decide si corresponde escribir el backup diario rotativo en Firestore.
 *
 * No escribe si:
 *   - falta `uid`
 *   - la base no tiene registros reales
 *   - ya se realizó el backup del día local actual en `storage`
 *
 * @param {string} uid
 * @param {Object} datos
 * @param {{ getItem?: Function } | null | undefined} storage
 * @param {Date} [fecha=new Date()]
 * @returns {{ debeEscribir: boolean, motivo?: string, fechaStr?: string, slotId?: string, claveStorage?: string }}
 */
export function evaluarBackupDiario(uid, datos, storage, fecha = new Date()) {
    if (!uid) {
        return { debeEscribir: false, motivo: 'SIN_UID' };
    }

    if (!baseTieneRegistros(datos)) {
        return { debeEscribir: false, motivo: 'BASE_VACIA' };
    }

    const fechaStr = obtenerFechaLocalYYYYMMDD(fecha);
    const slotId = obtenerSlotBackupSemanal(fecha);
    const claveStorage = obtenerClaveUltimoBackup(uid);

    let ultimoRegistrado = null;
    try {
        if (storage && typeof storage.getItem === 'function') {
            ultimoRegistrado = storage.getItem(claveStorage);
        }
    } catch (_) {
        ultimoRegistrado = null;
    }

    if (ultimoRegistrado === fechaStr) {
        return {
            debeEscribir: false,
            motivo: 'YA_REALIZADO_HOY',
            fechaStr,
            slotId,
            claveStorage
        };
    }

    return {
        debeEscribir: true,
        fechaStr,
        slotId,
        claveStorage
    };
}

/**
 * Marca en `storage` que el backup diario de `fechaStr` para `uid` fue escrito.
 *
 * @param {string} uid
 * @param {string} fechaStr
 * @param {{ setItem?: Function } | null | undefined} storage
 * @returns {boolean}
 */
export function marcarBackupDiarioRealizado(uid, fechaStr, storage) {
    if (!uid || !fechaStr || !storage || typeof storage.setItem !== 'function') {
        return false;
    }
    try {
        storage.setItem(obtenerClaveUltimoBackup(uid), String(fechaStr));
        return true;
    } catch (_) {
        return false;
    }
}
