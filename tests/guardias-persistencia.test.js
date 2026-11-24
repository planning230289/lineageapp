import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    baseTieneRegistros,
    crearControlPersistencia,
    obtenerFechaLocalYYYYMMDD,
    obtenerSlotBackupSemanal,
    obtenerClaveUltimoBackup,
    evaluarBackupDiario,
    marcarBackupDiarioRealizado
} from '../js/nucleo/guardias-persistencia.js';
import { crearBaseVacia } from '../js/nucleo/base.js';
import { crearEmisor } from '../js/core/eventos.js';
import { suscribirAvisosPersistencia } from '../js/core/avisos.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODIGO_DB = readFileSync(path.join(RAIZ, 'js', 'db.js'), 'utf8');
const CODIGO_APP = readFileSync(path.join(RAIZ, 'js', 'app.js'), 'utf8');
const CODIGO_COMPRAS = readFileSync(path.join(RAIZ, 'js', 'compras.js'), 'utf8');

function crearStorageMemoria() {
    const mapa = new Map();
    return {
        getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
        setItem: (k, v) => { mapa.set(k, String(v)); },
        removeItem: (k) => { mapa.delete(k); }
    };
}

describe('baseTieneRegistros', () => {
    it('retorna false ante null, undefined, primitivos, arrays u objetos vacíos', () => {
        expect(baseTieneRegistros(null)).toBe(false);
        expect(baseTieneRegistros(undefined)).toBe(false);
        expect(baseTieneRegistros('texto')).toBe(false);
        expect(baseTieneRegistros([])).toBe(false);
        expect(baseTieneRegistros({})).toBe(false);
        expect(baseTieneRegistros(crearBaseVacia('2026-11'))).toBe(false);
    });

    it('retorna false si los meses tienen arreglos vacíos o estructuras malformadas', () => {
        expect(baseTieneRegistros({
            ingresos: { '2026-11': [], '2026-12': null },
            gastos: { '2026-11': [] },
            deseos: [],
            pasivos: [],
            compras: []
        })).toBe(false);
    });

    it('retorna true si hay al menos un registro en ingresos, gastos, deseos, pasivos o compras', () => {
        expect(baseTieneRegistros({ ingresos: { '2026-11': [{ id: 'i1', valor: 100 }] } })).toBe(true);
        expect(baseTieneRegistros({ gastos: { '2026-11': [{ id: 'g1', monto: 50 }] } })).toBe(true);
        expect(baseTieneRegistros({ deseos: [{ id: 'd1', nombre: 'Bici' }] })).toBe(true);
        expect(baseTieneRegistros({ pasivos: [{ id: 'p1', nombre: 'Cuota' }] })).toBe(true);
        expect(baseTieneRegistros({ compras: [{ id: 'c1', nombre: 'Pan' }] })).toBe(true);
    });
});

describe('crearControlPersistencia: candado nubeListaParaUid y guardia anti-borrado', () => {
    const baseConDatos = {
        ...crearBaseVacia('2026-11'),
        gastos: { '2026-11': [{ id: 'g1', concepto: 'Luz', monto: 20000 }] }
    };
    const baseVacia = crearBaseVacia('2026-11');

    it('bloquea escrituras mientras la carga remota no haya finalizado para el uid', () => {
        const ctrl = crearControlPersistencia();
        expect(ctrl.obtenerNubeListaParaUid()).toBeNull();
        expect(ctrl.estaNubeListaPara('uid_A')).toBe(false);

        const resSinCargar = ctrl.validarEscrituraRemota('uid_A', baseConDatos);
        expect(resSinCargar.permitido).toBe(false);
        expect(resSinCargar.motivo).toBe('NUBE_NO_LISTA');
    });

    it('bloquea escrituras para otro uid y tras resetear', () => {
        const ctrl = crearControlPersistencia();
        ctrl.marcarNubeLista('uid_A', baseConDatos);
        expect(ctrl.estaNubeListaPara('uid_A')).toBe(true);
        expect(ctrl.estaNubeListaPara('uid_B')).toBe(false);

        const resOtroUid = ctrl.validarEscrituraRemota('uid_B', baseConDatos);
        expect(resOtroUid.permitido).toBe(false);
        expect(resOtroUid.motivo).toBe('NUBE_NO_LISTA');

        ctrl.resetear();
        expect(ctrl.obtenerNubeListaParaUid()).toBeNull();
        expect(ctrl.validarEscrituraRemota('uid_A', baseConDatos).motivo).toBe('NUBE_NO_LISTA');
    });

    it('bloquea escritura de base vacía si la cuenta ya tenía datos (anti-borrado)', () => {
        const ctrl = crearControlPersistencia();
        ctrl.marcarNubeLista('uid_A', baseConDatos);
        expect(ctrl.cuentaTeniaDatos('uid_A')).toBe(true);

        const res = ctrl.validarEscrituraRemota('uid_A', baseVacia);
        expect(res.permitido).toBe(false);
        expect(res.motivo).toBe('BLOQUEO_ANTI_BORRADO');
        expect(res.mensaje).toContain('proteger');
    });

    it('permite guardar base vacía en una cuenta nueva y activa protección al agregar datos', () => {
        const ctrl = crearControlPersistencia();
        ctrl.marcarNubeLista('uid_nuevo', baseVacia);
        expect(ctrl.cuentaTeniaDatos('uid_nuevo')).toBe(false);
        expect(ctrl.validarEscrituraRemota('uid_nuevo', baseVacia).permitido).toBe(true);

        // El usuario agrega datos durante la sesión
        ctrl.registrarDatosConfirmados('uid_nuevo', baseConDatos);
        expect(ctrl.cuentaTeniaDatos('uid_nuevo')).toBe(true);

        // Ahora una escritura vacía queda bloqueada
        const res = ctrl.validarEscrituraRemota('uid_nuevo', baseVacia);
        expect(res.permitido).toBe(false);
        expect(res.motivo).toBe('BLOQUEO_ANTI_BORRADO');
    });
});

describe('backups diarios rotativos en Firestore (7 días)', () => {
    const baseConDatos = {
        ...crearBaseVacia('2026-11'),
        deseos: [{ id: 'd1', nombre: 'Viaje' }]
    };

    it('formatea fecha local YYYY-MM-DD y mapea los 7 slots dia_0..dia_6', () => {
        // 2026-11-22 es domingo (getDay() === 0) en fecha local
        const domingo = new Date(2026, 10, 22, 10, 30, 0);
        const sabado = new Date(2026, 10, 28, 10, 30, 0);
        expect(obtenerFechaLocalYYYYMMDD(domingo)).toBe('2026-11-22');
        expect(obtenerSlotBackupSemanal(domingo)).toBe('dia_0');
        expect(obtenerSlotBackupSemanal(sabado)).toBe('dia_6');
        expect(obtenerClaveUltimoBackup('uid_1')).toBe('ultimo_backup_nube_uid_1');
    });

    it('escribe solo una vez por día local, omite base vacía y vuelve a escribir al día siguiente', () => {
        const storage = crearStorageMemoria();
        const lunes = new Date(2026, 10, 23, 9, 0, 0);
        const martes = new Date(2026, 10, 24, 9, 0, 0);

        // Base vacía nunca dispara backup
        expect(evaluarBackupDiario('uid_1', crearBaseVacia('2026-11'), storage, lunes).debeEscribir).toBe(false);

        // Primera escritura del lunes -> sí escribe en dia_1
        const eval1 = evaluarBackupDiario('uid_1', baseConDatos, storage, lunes);
        expect(eval1.debeEscribir).toBe(true);
        expect(eval1.slotId).toBe('dia_1');
        expect(eval1.fechaStr).toBe('2026-11-23');
        expect(eval1.claveStorage).toBe('ultimo_backup_nube_uid_1');

        // Tras marcarlo como realizado, otro guardado el mismo día no reescribe
        expect(marcarBackupDiarioRealizado('uid_1', eval1.fechaStr, storage)).toBe(true);
        const eval2 = evaluarBackupDiario('uid_1', baseConDatos, storage, lunes);
        expect(eval2.debeEscribir).toBe(false);

        // Al día siguiente (martes) vuelve a escribir en dia_2
        const eval3 = evaluarBackupDiario('uid_1', baseConDatos, storage, martes);
        expect(eval3.debeEscribir).toBe(true);
        expect(eval3.slotId).toBe('dia_2');
        expect(eval3.fechaStr).toBe('2026-11-24');
    });
});

describe('aviso al usuario por bloqueo anti-borrado', () => {
    it('muestra un error dedicado cuando db:error llega con motivo anti-borrado', () => {
        const consolaSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const bus = crearEmisor('test-anti-borrado');
        const notificarError = vi.fn();
        const notificarExito = vi.fn();

        suscribirAvisosPersistencia(bus, { notificarError, notificarExito });
        bus.emitir('db:error', {
            operacion: 'guardar',
            motivo: 'anti-borrado',
            mensaje: 'Se bloqueó la escritura de una base vacía para proteger tus datos en la nube.'
        });

        expect(notificarError).toHaveBeenCalledTimes(1);
        expect(notificarError).toHaveBeenCalledWith(
            expect.stringContaining('proteger tus datos en la nube'),
            { clave: 'db-error-anti-borrado' }
        );
        consolaSpy.mockRestore();
    });
});

describe('verificación estática de aislamiento y candados en db.js, app.js y compras.js', () => {
    it('elimina toda lectura y escritura a finanzas_db_fallback en los módulos activos', () => {
        for (const [nombre, codigo] of [
            ['js/db.js', CODIGO_DB],
            ['js/app.js', CODIGO_APP],
            ['js/compras.js', CODIGO_COMPRAS]
        ]) {
            expect(codigo, `${nombre} no debe escribir finanzas_db_fallback`).not.toMatch(/setItem\(\s*['"]finanzas_db_fallback['"]/);
            expect(codigo, `${nombre} no debe leer finanzas_db_fallback`).not.toMatch(/getItem\(\s*['"]finanzas_db_fallback['"]/);
        }
    });

    it('verifica presencia de nubeListaParaUid, limpieza en cerrarSesion y subcolección backups en db.js', () => {
        expect(CODIGO_DB).toContain('nubeListaParaUid');
        expect(CODIGO_DB).toMatch(/export\s+function\s+estaNubeListaPara/);
        expect(CODIGO_DB).toMatch(/export\s+function\s+puedeGuardarLocalPara/);
        expect(CODIGO_DB).toMatch(/export\s+function\s+marcarCifradoConfirmado/);
        expect(CODIGO_DB).toMatch(/export\s+function\s+tieneCifradoActivoLocal/);
        expect(CODIGO_DB).toMatch(/cerrarSesion\(\)[\s\S]*bloquearSesionCripto\(uid\)[\s\S]*reiniciarDbEnMemoria\(\)[\s\S]*controlPersistencia\.resetear\(\)/);
        expect(CODIGO_DB).toMatch(/escribirEnNube\([\s\S]*'backups'/);
    });

    it('verifica token de vigencia, forzarDesdeNube, cancelación de PIN y clonado síncrono en db.js', () => {
        expect(CODIGO_DB).toContain('secuenciaCargaRemota');
        expect(CODIGO_DB).toContain('sigueVigente');
        expect(CODIGO_DB).toContain('forzarDesdeNube');
        expect(CODIGO_DB).toContain("error?.message === 'DESBLOQUEO_CANCELADO'");
        expect(CODIGO_DB).toContain('clonarObjetoSeguro');
        expect(CODIGO_DB).toMatch(/escribirEnNube\([\s\S]*const\s+snapshotInmutable\s*=\s*clonarObjetoSeguro\(datos\)/);
        expect(CODIGO_DB).toMatch(/!tieneCifradoActivoLocal\(uid\)\)\s*\{\s*guardarSnapshotEnHistorial/);
    });

    it('verifica remediaciones en app.js: forzarDesdeNube, cierre reentrante, activación cifrado, importación/restauración segura y escape XSS', () => {
        expect(CODIGO_APP).toMatch(/forzarSincronizacion\([\s\S]*forzarDesdeNube:\s*true/);
        expect(CODIGO_APP).toContain('let cierreSesionEnCurso = false;');
        expect(CODIGO_APP).toMatch(/cerrarPorInactividad\([\s\S]*estaNubeListaPara\(uid\)\s*:\s*false/);
        expect(CODIGO_APP).toMatch(/handleCerrarSesion\([\s\S]*estaNubeListaPara\(uid\)\s*:\s*false/);
        expect(CODIGO_APP).toMatch(/handleGuardarConfiguracionCifrado\([\s\S]*guardarTodo\('activacion-cifrado'\)[\s\S]*resGuardado\?\.ok\s*&&\s*resGuardado\?\.destino\s*===\s*'nube'/);
        expect(CODIGO_APP).toMatch(/importarRespaldoJSONAuto\([\s\S]*delete\s+dbNueva\.uid;[\s\S]*resGuardado\?\.ok\s*&&\s*resGuardado\?\.destino\s*===\s*'nube'/);
        expect(CODIGO_APP).toMatch(/accionRestaurarCopia\([\s\S]*delete\s+baseLista\.uid;[\s\S]*resGuardado\?\.ok\s*&&\s*resGuardado\?\.destino\s*===\s*'nube'/);
        expect(CODIGO_APP).toMatch(/renderizarListaRespaldosModal\([\s\S]*escapeHTML\(/);
        expect(CODIGO_APP).toMatch(/initApp\([\s\S]*resultado\.cancelado\s*\|\|\s*resultado\.obsoleta/);
    });

    it('verifica aislamiento por UID y respeto de Cero Conocimiento en compras.js', () => {
        expect(CODIGO_COMPRAS).toContain('tieneCifradoActivoLocal');
        expect(CODIGO_COMPRAS).toMatch(/export\s+function\s+limpiarStorageCompras/);
        expect(CODIGO_COMPRAS).not.toMatch(/return\s+uid\s*\?[^;]*'compras_lineage_anon'/);
    });
});
