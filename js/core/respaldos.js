/* =========================================================
   SISTEMA DE RESPALDOS ROTATIVOS (js/core/respaldos.js)
   Gestión cíclica de hasta 5 copias numeradas de seguridad,
   purgado de copias viejas y restauración de snapshots.
   Libre de dependencias de red o Firebase.
   ========================================================= */

import { formatARS } from '../utils/formato.js';

export const CLAVE_INDICE_ROTACION = 'finanzas_backup_rotacion_index';
export const CLAVE_HISTORIAL_COPIAS = 'finanzas_copias_respaldo_historial';
export const LIMITE_MAXIMO_COPIAS = 5;

let _secuenciaCopia = 0;

/**
 * Normaliza el identificador de usuario para claves aisladas en storage.
 * @param {string|null} [usuarioId=null]
 * @returns {string|null}
 */
function normalizarUsuarioId(usuarioId = null) {
    if (typeof usuarioId !== 'string') return null;
    const limpio = usuarioId.trim();
    return limpio.length > 0 ? limpio : null;
}

/**
 * Devuelve la clave de almacenamiento para el índice rotativo, aislada por UID si existe.
 *
 * @param {string|null} [usuarioId=null]
 * @returns {string}
 */
export function obtenerClaveIndiceRotacion(usuarioId = null) {
    const uid = normalizarUsuarioId(usuarioId);
    return uid ? `${CLAVE_INDICE_ROTACION}_${uid}` : CLAVE_INDICE_ROTACION;
}

/**
 * Devuelve la clave de almacenamiento para el historial de copias, aislada por UID si existe.
 *
 * @param {string|null} [usuarioId=null]
 * @returns {string}
 */
export function obtenerClaveHistorialCopias(usuarioId = null) {
    const uid = normalizarUsuarioId(usuarioId);
    return uid ? `${CLAVE_HISTORIAL_COPIAS}_${uid}` : CLAVE_HISTORIAL_COPIAS;
}

/**
 * Obtiene el índice actual de rotación (entre 1 y 5).
 * Si no está definido o es inválido, devuelve 1.
 *
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {number}
 */
export function obtenerIndiceRotacion(almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    if (!almacenamiento) return 1;
    try {
        const val = almacenamiento.getItem(obtenerClaveIndiceRotacion(usuarioId));
        const num = parseInt(val, 10);
        if (Number.isInteger(num) && num >= 1 && num <= LIMITE_MAXIMO_COPIAS) {
            return num;
        }
    } catch (_) {}
    return 1;
}

/**
 * Avanza el índice de rotación de forma cíclica (1 -> 2 -> ... -> 5 -> 1).
 * Devuelve el nuevo número asignado (1 a 5).
 *
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {number}
 */
export function avanzarIndiceRotacion(almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    const actual = obtenerIndiceRotacion(almacenamiento, usuarioId);
    const siguiente = actual >= LIMITE_MAXIMO_COPIAS ? 1 : actual + 1;
    if (almacenamiento) {
        try {
            almacenamiento.setItem(obtenerClaveIndiceRotacion(usuarioId), String(siguiente));
        } catch (_) {}
    }
    return siguiente;
}

/**
 * Devuelve el nombre de archivo rotativo correspondiente al índice dado o al actual.
 *
 * @param {number} [indice]
 * @param {Storage|Object} [almacenamiento]
 * @param {string|null} [usuarioId=null]
 * @returns {string} Ej: "Finanzas_Lineage_Copia_1.json"
 */
export function generarNombreCopiaRotativa(indice = null, almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    let num = indice;
    if (typeof num !== 'number' || num < 1 || num > LIMITE_MAXIMO_COPIAS) {
        num = obtenerIndiceRotacion(almacenamiento, usuarioId);
    }
    return `Finanzas_Lineage_Copia_${num}.json`;
}

/**
 * Formatea una fecha y hora legible para el usuario en zona local.
 *
 * @param {Date|number} [fechaODate=new Date()]
 * @returns {string} Ej: "22/10/2026, 12:30"
 */
export function formatearFechaCopia(fechaODate = new Date()) {
    try {
        const d = fechaODate instanceof Date ? fechaODate : new Date(fechaODate);
        if (isNaN(d.getTime())) return '';
        const dia = String(d.getDate()).padStart(2, '0');
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        const anio = d.getFullYear();
        const horas = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        return `${dia}/${mes}/${anio}, ${horas}:${mins}`;
    } catch (_) {
        return '';
    }
}

/**
 * Extrae un resumen amigable de la base para mostrar en la lista de respaldos.
 *
 * @param {Object} data
 * @returns {{ saldoNeto: string|null, resumen: string }}
 */
export function extraerResumenBase(data) {
    if (!data || typeof data !== 'object') {
        return { saldoNeto: null, resumen: 'Copia sin datos' };
    }

    try {
        const mesActivo = data.mesActivo || '';
        let info = mesActivo ? `Mes: ${mesActivo}` : 'Base de datos';

        // Contar transacciones
        let cantIngresos = 0;
        let cantGastos = 0;
        if (data.ingresos && typeof data.ingresos === 'object') {
            Object.values(data.ingresos).forEach(arr => {
                if (Array.isArray(arr)) cantIngresos += arr.length;
            });
        }
        if (data.gastos && typeof data.gastos === 'object') {
            Object.values(data.gastos).forEach(arr => {
                if (Array.isArray(arr)) cantGastos += arr.length;
            });
        }

        const detalles = [];
        if (cantIngresos > 0) detalles.push(`${cantIngresos} ingresos`);
        if (cantGastos > 0) detalles.push(`${cantGastos} gastos`);
        if (detalles.length > 0) {
            info += ` (${detalles.join(', ')})`;
        }

        return {
            saldoNeto: null,
            resumen: info
        };
    } catch (_) {
        return { saldoNeto: null, resumen: 'Copia de respaldo' };
    }
}

/**
 * Obtiene el historial de copias de respaldo de localStorage (máximo 5).
 * Ordenadas desde la más reciente a la más antigua.
 *
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {Array<{ id: string, numero: number, fecha: string, timestamp: number, data: Object, saldoNeto: string|null, resumen: string }>}
 */
export function obtenerHistorialCopias(almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    if (!almacenamiento) return [];
    try {
        const crudo = almacenamiento.getItem(obtenerClaveHistorialCopias(usuarioId));
        if (!crudo) return [];
        const arr = JSON.parse(crudo);
        if (Array.isArray(arr)) {
            return arr.filter(item => item && typeof item === 'object' && item.data);
        }
    } catch (e) {
        console.warn('[respaldos] Error al obtener historial:', e);
    }
    return [];
}

/**
 * Purga el historial asegurando que solo se conserven las 5 copias más recientes.
 *
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {Array} Copias restantes (máximo 5)
 */
export function purgarCopiasAntiguas(almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    if (!almacenamiento) return [];
    try {
        const copias = obtenerHistorialCopias(almacenamiento, usuarioId);
        // Si hay más de 5, conservar solo las primeras 5 (las más recientes)
        const conservadas = copias.slice(0, LIMITE_MAXIMO_COPIAS);
        almacenamiento.setItem(obtenerClaveHistorialCopias(usuarioId), JSON.stringify(conservadas));
        return conservadas;
    } catch (e) {
        console.warn('[respaldos] Error al purgar copias antiguas:', e);
        return [];
    }
}

/**
 * Guarda una nueva copia de snapshot en el historial y avanza el índice rotativo.
 * Garantiza que nunca se supere el límite de 5 copias (purga las más viejas).
 *
 * @param {Object} data - Objeto de datos a respaldar
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {{ id: string, numero: number, fecha: string, timestamp: number, nombreArchivo: string }}
 */
export function guardarSnapshotEnHistorial(data, almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const indiceActual = obtenerIndiceRotacion(almacenamiento, usuarioId);
    const ahora = Date.now();
    const id = `backup_${ahora}_${indiceActual}_${++_secuenciaCopia}`;
    const fecha = formatearFechaCopia(ahora);
    const { saldoNeto, resumen } = extraerResumenBase(data);

    // Clonar defensivamente para evitar mutaciones externas
    let snapshotData;
    try {
        snapshotData = JSON.parse(JSON.stringify(data));
    } catch (_) {
        snapshotData = Object.assign({}, data);
    }

    const nuevaCopia = {
        id,
        numero: indiceActual,
        fecha,
        timestamp: ahora,
        data: snapshotData,
        saldoNeto,
        resumen
    };

    if (almacenamiento) {
        try {
            const actuales = obtenerHistorialCopias(almacenamiento, usuarioId);
            // Insertar al inicio (más reciente)
            const nuevoHistorial = [nuevaCopia, ...actuales].slice(0, LIMITE_MAXIMO_COPIAS);
            almacenamiento.setItem(obtenerClaveHistorialCopias(usuarioId), JSON.stringify(nuevoHistorial));

            // Avanzar el índice cíclico para la próxima copia (1 a 5)
            avanzarIndiceRotacion(almacenamiento, usuarioId);
        } catch (e) {
            console.warn('[respaldos] Error al guardar snapshot en historial:', e);
        }
    }

    return {
        id,
        numero: indiceActual,
        fecha,
        timestamp: ahora,
        nombreArchivo: `Finanzas_Lineage_Copia_${indiceActual}.json`
    };
}

/**
 * Restaura una copia de respaldo seleccionada por su ID o por el objeto copia.
 * Devuelve el objeto base de datos listo para preparar y renderizar.
 *
 * @param {string|Object} idOCopia
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @param {string|null} [usuarioId=null]
 * @returns {Object|null}
 */
export function restaurarCopiaDesdeHistorial(idOCopia, almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null), usuarioId = null) {
    if (!idOCopia) return null;

    if (typeof idOCopia === 'object' && idOCopia.data) {
        return JSON.parse(JSON.stringify(idOCopia.data));
    }

    const copias = obtenerHistorialCopias(almacenamiento, usuarioId);
    const encontrada = copias.find(c => c.id === idOCopia || String(c.numero) === String(idOCopia));
    if (encontrada && encontrada.data) {
        return JSON.parse(JSON.stringify(encontrada.data));
    }

    return null;
}

/**
 * Purga las claves del historial de copias y el índice rotativo del usuario
 * y también las claves globales heredadas sin UID.
 *
 * @param {string|null} [usuarioId=null]
 * @param {Storage|Object} [almacenamiento=localStorage]
 * @returns {boolean}
 */
export function limpiarHistorialCopias(usuarioId = null, almacenamiento = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!almacenamiento || typeof almacenamiento.removeItem !== 'function') return false;
    try {
        const uid = normalizarUsuarioId(usuarioId);
        if (uid) {
            almacenamiento.removeItem(obtenerClaveHistorialCopias(uid));
            almacenamiento.removeItem(obtenerClaveIndiceRotacion(uid));
        }
        almacenamiento.removeItem(CLAVE_HISTORIAL_COPIAS);
        almacenamiento.removeItem(CLAVE_INDICE_ROTACION);
        return true;
    } catch (e) {
        console.warn('[respaldos] Error al limpiar historial de copias:', e);
        return false;
    }
}
