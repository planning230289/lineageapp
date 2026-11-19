/* =========================================================
   EXPORTACIÓN EXCEL DE PASIVOS CONSOLIDADOS
   =========================================================
   Genera una tabla HTML UTF-8 compatible con Excel (.xls) sin
   dependencias externas, con sanitización contra XSS y contra
   inyección de fórmulas (CSV/Excel Formula Injection).
   ========================================================= */

import { formatARS } from './formato.js';

/**
 * Escapa caracteres HTML especiales para prevenir XSS en celdas.
 * @param {*} valor
 * @returns {string}
 */
export function escapeHtmlExcel(valor) {
    if (valor == null) return '';
    return String(valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitiza un texto contra inyección de fórmulas en Excel/CSV.
 * Prefija con apóstrofe (') si el texto (ignorando espacios iniciales)
 * comienza con =, +, -, @, \t o \r.
 * @param {*} valor
 * @returns {string}
 */
export function sanitizarCeldaExcel(valor) {
    if (valor == null) return '';
    const texto = String(valor);
    if (/^\s*[=+\-@\t\r]/.test(texto)) {
        return `'${texto}`;
    }
    return texto;
}

/**
 * Formatea una celda de texto aplicando sanitización de fórmula y escape HTML.
 * @param {*} valor
 * @returns {string}
 */
function celdaTextoSegura(valor) {
    return escapeHtmlExcel(sanitizarCeldaExcel(valor));
}

/**
 * Genera el contenido HTML completo para exportar pasivos consolidados a .xls.
 *
 * @param {Array<{nombre: string, keyword?: string, calculo: {totalDeuda: number, cuotasRestantes: number, detallePorMes: Array}}>} pasivosConCalculo
 * @returns {string} Documento HTML UTF-8 listo para Blob .xls
 */
export function generarHtmlExcelPasivos(pasivosConCalculo) {
    const lista = Array.isArray(pasivosConCalculo) ? pasivosConCalculo : [];
    const filas = [];
    let totalGeneral = 0;
    let cuotasGenerales = 0;

    for (const pasivo of lista) {
        if (!pasivo || !pasivo.calculo) continue;
        const nombrePasivo = pasivo.nombre || 'Pasivo';
        const { totalDeuda = 0, cuotasRestantes = 0, detallePorMes = [] } = pasivo.calculo;

        totalGeneral += Number(totalDeuda) || 0;
        cuotasGenerales += Number(cuotasRestantes) || 0;

        if (detallePorMes.length === 0) {
            filas.push(
                `<tr>` +
                `<td>${celdaTextoSegura(nombrePasivo)}</td>` +
                `<td>-</td>` +
                `<td>Sin cuotas pendientes</td>` +
                `<td class="num">${escapeHtmlExcel(formatARS(0))}</td>` +
                `</tr>`
            );
        } else {
            for (const mesObj of detallePorMes) {
                const items = Array.isArray(mesObj.items) ? mesObj.items : [];
                for (const item of items) {
                    filas.push(
                        `<tr>` +
                        `<td>${celdaTextoSegura(nombrePasivo)}</td>` +
                        `<td>${celdaTextoSegura(mesObj.mes)}</td>` +
                        `<td>${celdaTextoSegura(item.concepto)}</td>` +
                        `<td class="num">${escapeHtmlExcel(formatARS(item.monto))}</td>` +
                        `</tr>`
                    );
                }
                filas.push(
                    `<tr class="subtotal">` +
                    `<td>${celdaTextoSegura(nombrePasivo)}</td>` +
                    `<td>${celdaTextoSegura(mesObj.mes)}</td>` +
                    `<td>Subtotal (${mesObj.cantidad} ${mesObj.cantidad === 1 ? 'cuota' : 'cuotas'})</td>` +
                    `<td class="num">${escapeHtmlExcel(formatARS(mesObj.subtotal))}</td>` +
                    `</tr>`
                );
            }
        }

        filas.push(
            `<tr class="total-pasivo">` +
            `<td>${celdaTextoSegura(nombrePasivo)}</td>` +
            `<td colspan="2">Total Pasivo (${cuotasRestantes} ${cuotasRestantes === 1 ? 'cuota' : 'cuotas'})</td>` +
            `<td class="num">${escapeHtmlExcel(formatARS(totalDeuda))}</td>` +
            `</tr>`
        );
    }

    if (lista.length > 1) {
        filas.push(
            `<tr class="total-general">` +
            `<td colspan="3">Total General (${cuotasGenerales} ${cuotasGenerales === 1 ? 'cuota' : 'cuotas'})</td>` +
            `<td class="num">${escapeHtmlExcel(formatARS(totalGeneral))}</td>` +
            `</tr>`
        );
    }

    if (filas.length === 0) {
        filas.push('<tr><td colspan="4">No hay pasivos consolidados para exportar.</td></tr>');
    }

    return [
        '<!DOCTYPE html>',
        '<html lang="es">',
        '<head>',
        '<meta charset="UTF-8">',
        '<style>',
        'table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 12px; }',
        'th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; }',
        'th { background-color: #eef2ff; font-weight: bold; }',
        '.num { text-align: right; }',
        '.subtotal { background-color: #f3f4f6; font-weight: bold; }',
        '.total-pasivo { background-color: #e0e7ff; font-weight: bold; }',
        '.total-general { background-color: #c7d2fe; font-weight: bold; }',
        '</style>',
        '</head>',
        '<body>',
        '<table>',
        '<thead>',
        '<tr><th>Pasivo</th><th>Mes</th><th>Concepto</th><th>Monto</th></tr>',
        '</thead>',
        '<tbody>',
        ...filas,
        '</tbody>',
        '</table>',
        '</body>',
        '</html>'
    ].join('\n');
}

/**
 * Descarga un archivo .xls en el navegador con BOM UTF-8.
 *
 * @param {Array} pasivosConCalculo
 * @param {string} [nombreArchivo='pasivos-consolidados.xls']
 * @returns {boolean} true si se disparó la descarga
 */
export function descargarExcelPasivos(pasivosConCalculo, nombreArchivo = 'pasivos-consolidados.xls') {
    const html = generarHtmlExcelPasivos(pasivosConCalculo);
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return false;
    }

    const blob = new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreArchivo;
    document.body.appendChild(enlace);
    enlace.click();
    document.body.removeChild(enlace);
    URL.revokeObjectURL(url);
    return true;
}
