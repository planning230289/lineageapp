/* =========================================================
   REPLICACIÓN DEL ORDEN DE GASTOS (js/negocio/orden-gastos.js)
   =========================================================
   Capa de negocio pura: no importa db.js, no toca el DOM ni
   interactúa con Firebase.

   Propósito:
   Cuando la persona reordena los gastos del mes activo (subir,
   bajar, mover al principio/final o arrastrar y soltar), ese
   mismo orden relativo se replica automáticamente hacia los
   meses posteriores (mes > mesActual), sin tocar jamás el
   historial de meses pasados (mes < mesActual) ni alterar los
   atributos propios de cada mes futuro (id, monto, pagado,
   desestimado, número de cuota, etc.).
   ========================================================= */

import { normalizarCategoria, normalizarTexto } from '../calculos/nucleo.js';
import { parsearCuota } from '../version.js';

/** ¿Es un objeto plano (no null, no array)? */
function esObjetoPlano(valor) {
    return !!valor && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Construye una clave estable de identidad para emparejar el mismo
 * gasto o plan de cuotas entre meses distintos.
 *
 * - Para cuotas: prioriza `grupoId` si existe; si no, extrae el
 *   concepto base sin el sufijo "(Cuota X/Y)" mediante `parsearCuota`.
 * - Para fijos, únicos u otra categoría: combina categoría y concepto
 *   normalizados.
 *
 * @param {*} gasto Objeto de gasto
 * @returns {string} Clave normalizada, o '' si el gasto no es válido
 */
export function claveOrdenGasto(gasto) {
    if (!esObjetoPlano(gasto)) return '';

    const cat = normalizarCategoria(gasto.categoria);
    if (!cat) return '';

    if (cat === 'cuotas') {
        const grupo = typeof gasto.grupoId === 'string' ? normalizarTexto(gasto.grupoId) : '';
        if (grupo) {
            return `cuotas|grupo:${grupo}`;
        }
        const partes = parsearCuota(gasto.concepto);
        const base = normalizarTexto(partes ? partes.base : gasto.concepto);
        return base ? `cuotas|base:${base}` : '';
    }

    const concepto = normalizarTexto(gasto.concepto);
    return concepto ? `${cat}|${concepto}` : '';
}

/**
 * Replica el orden relativo de los gastos de `mesActual` hacia todos
 * los meses posteriores (`mes > mesActual`) en `gastosPorMes`.
 *
 * Reglas:
 * 1. Nunca modifica `mes <= mesActual`.
 * 2. Dentro de cada categoría en un mes futuro, los gastos que
 *    coinciden con una clave de `mesActual` ocupan las mismas ranuras
 *    (slots) que ya ocupaban en ese mes futuro, pero ordenados entre
 *    sí según su posición en `mesActual` (con desempate estable por
 *    su índice original en el mes futuro).
 * 3. Los gastos exclusivos del mes futuro que no existen en `mesActual`
 *    permanecen exactamente en su posición original.
 * 4. Modifica cada array futuro in-place (`splice`) únicamente si el
 *    orden cambió de forma efectiva.
 *
 * @param {Object<string, Array<Object>>} gastosPorMes Mapa de listas de gastos por clave "YYYY-MM"
 * @param {string} mesActual Clave "YYYY-MM" del mes tomado como referencia
 * @returns {{ mesesReordenados: number }} Cantidad de meses futuros cuyo orden cambió
 */
export function replicarOrdenGastosHaciaAdelante(gastosPorMes, mesActual) {
    if (!esObjetoPlano(gastosPorMes)) return { mesesReordenados: 0 };
    if (typeof mesActual !== 'string' || mesActual.trim() === '') return { mesesReordenados: 0 };

    const listaActual = gastosPorMes[mesActual];
    if (!Array.isArray(listaActual)) return { mesesReordenados: 0 };

    const ordenReferencia = new Map();
    for (const gasto of listaActual) {
        const clave = claveOrdenGasto(gasto);
        if (clave && !ordenReferencia.has(clave)) {
            ordenReferencia.set(clave, ordenReferencia.size);
        }
    }

    if (ordenReferencia.size === 0) return { mesesReordenados: 0 };

    let mesesReordenados = 0;
    const clavesMes = Object.keys(gastosPorMes).sort();

    for (const mes of clavesMes) {
        if (mes <= mesActual) continue;

        const lista = gastosPorMes[mes];
        if (!Array.isArray(lista) || lista.length < 2) continue;

        const nuevaLista = lista.slice();
        const ranurasPorCategoria = new Map();

        for (let i = 0; i < lista.length; i++) {
            const item = lista[i];
            const clave = claveOrdenGasto(item);
            if (!clave || !ordenReferencia.has(clave)) continue;

            const cat = normalizarCategoria(item.categoria);
            if (!ranurasPorCategoria.has(cat)) {
                ranurasPorCategoria.set(cat, []);
            }
            ranurasPorCategoria.get(cat).push({
                indiceOriginal: i,
                prioridad: ordenReferencia.get(clave),
                item
            });
        }

        for (const entradas of ranurasPorCategoria.values()) {
            if (entradas.length < 2) continue;

            const indicesDestino = entradas.map(e => e.indiceOriginal);
            const ordenadas = entradas.slice().sort((a, b) => {
                if (a.prioridad !== b.prioridad) return a.prioridad - b.prioridad;
                return a.indiceOriginal - b.indiceOriginal;
            });

            for (let j = 0; j < indicesDestino.length; j++) {
                nuevaLista[indicesDestino[j]] = ordenadas[j].item;
            }
        }

        const cambioEfectivo = nuevaLista.some((item, idx) => item !== lista[idx]);
        if (cambioEfectivo) {
            lista.splice(0, lista.length, ...nuevaLista);
            mesesReordenados += 1;
        }
    }

    return { mesesReordenados };
}
