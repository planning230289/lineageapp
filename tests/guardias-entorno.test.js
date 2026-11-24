import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    evaluarBateria,
    verificarConectividadFirebase,
    crearMonitorEntorno,
    entornoEstaBloqueado,
    resetearEstadoGlobalEntorno
} from '../js/nucleo/guardias-entorno.js';

describe('guardias-entorno: evaluación de batería', () => {
    it('no bloquea si navigator o getBattery no están soportados', async () => {
        const resSinNav = await evaluarBateria(null);
        expect(resSinNav).toEqual({ soportado: false, bloqueado: false, nivel: null, cargando: null });

        const resSinApi = await evaluarBateria({});
        expect(resSinApi).toEqual({ soportado: false, bloqueado: false, nivel: null, cargando: null });
    });

    it('bloquea cuando la batería está al 14% (0.14) y no está cargando', async () => {
        const navMock = {
            getBattery: async () => ({ level: 0.14, charging: false })
        };
        const res = await evaluarBateria(navMock);
        expect(res.soportado).toBe(true);
        expect(res.bloqueado).toBe(true);
        expect(res.porcentaje).toBe(14);
    });

    it('NO bloquea cuando la batería está al 10% (0.10) pero está cargando', async () => {
        const navMock = {
            getBattery: async () => ({ level: 0.10, charging: true })
        };
        const res = await evaluarBateria(navMock);
        expect(res.soportado).toBe(true);
        expect(res.bloqueado).toBe(false);
    });

    it('NO bloquea cuando la batería está exactamente al 15% (0.15) sin cargar', async () => {
        const navMock = {
            getBattery: async () => ({ level: 0.15, charging: false })
        };
        const res = await evaluarBateria(navMock);
        expect(res.soportado).toBe(true);
        expect(res.bloqueado).toBe(false);
    });
});

describe('guardias-entorno: conectividad Firebase', () => {
    it('devuelve SIN_INTERNET de inmediato si navigator.onLine === false', async () => {
        const getDocFromServer = vi.fn();
        const res = await verificarConectividadFirebase({
            nav: { onLine: false },
            dbFirestore: {},
            doc: () => ({}),
            getDocFromServer
        });
        expect(res).toEqual({ ok: false, motivo: 'SIN_INTERNET' });
        expect(getDocFromServer).not.toHaveBeenCalled();
    });

    it('devuelve SIN_FIREBASE ante error de red o timeout', async () => {
        const errRed = new Error('unavailable');
        errRed.code = 'unavailable';

        const resRed = await verificarConectividadFirebase({
            nav: { onLine: true },
            dbFirestore: {},
            doc: () => ({}),
            getDocFromServer: async () => { throw errRed; }
        });
        expect(resRed.ok).toBe(false);
        expect(resRed.motivo).toBe('SIN_FIREBASE');

        const resTimeout = await verificarConectividadFirebase({
            nav: { onLine: true },
            dbFirestore: {},
            doc: () => ({}),
            getDocFromServer: () => new Promise(() => {}),
            timeoutMs: 20
        });
        expect(resTimeout.ok).toBe(false);
        expect(resTimeout.motivo).toBe('SIN_FIREBASE');
    });

    it('devuelve ok: true cuando el servidor responde permission-denied', async () => {
        const errPermiso = new Error('Missing or insufficient permissions');
        errPermiso.code = 'permission-denied';

        const res = await verificarConectividadFirebase({
            nav: { onLine: true },
            dbFirestore: {},
            doc: () => ({}),
            getDocFromServer: async () => { throw errPermiso; }
        });
        expect(res).toEqual({ ok: true, motivo: null });
    });
});

describe('guardias-entorno: monitor reactivo y estado global', () => {
    beforeEach(() => {
        resetearEstadoGlobalEntorno();
    });

    it('bloquea con SIN_INTERNET cuando navigator.onLine es false', async () => {
        const onCambio = vi.fn();
        const monitor = crearMonitorEntorno({
            nav: { onLine: false },
            win: null,
            verificarFirebase: async () => ({ ok: true }),
            onCambio
        });

        const estado = await monitor.iniciar();
        expect(estado.bloqueado).toBe(true);
        expect(estado.motivo).toBe('SIN_INTERNET');
        expect(onCambio).toHaveBeenCalled();
        monitor.detener();
    });

    it('bloquea con BATERIA_BAJA cuando está al 14% sin cargar y actualiza entornoEstaBloqueado()', async () => {
        const monitor = crearMonitorEntorno({
            nav: {
                onLine: true,
                getBattery: async () => ({
                    level: 0.14,
                    charging: false,
                    addEventListener: () => {},
                    removeEventListener: () => {}
                })
            },
            win: null,
            verificarFirebase: async () => ({ ok: true })
        });

        const estado = await monitor.iniciar();
        expect(estado.bloqueado).toBe(true);
        expect(estado.motivo).toBe('BATERIA_BAJA');
        expect(entornoEstaBloqueado()).toBe(true);
        monitor.detener();
    });
});
