import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
    mesActivo: '2026-03',
    gastos: {}
}));

vi.mock('../js/db.js', () => ({
    db: mockDb,
    guardarTodo: vi.fn()
}));

vi.mock('../js/notificaciones.js', () => ({
    mostrarNotificacion: vi.fn(),
    notificarExito: vi.fn()
}));

import {
    pasarGastoAlAnterior,
    pasarGastoAlSiguiente,
    deshacerRollover
} from '../js/app.rollover.js';

describe('Rollover de gastos (básico)', () => {
    beforeEach(() => {
        mockDb.mesActivo = '2026-03';
        mockDb.gastos = {
            '2026-02': [],
            '2026-03': [
                {
                    id: 'g1',
                    concepto: 'Seguro Auto',
                    categoria: 'Fijos',
                    monto: 45000,
                    pagado: false,
                    grupoId: 'grp-1'
                },
                {
                    id: 'g2',
                    concepto: 'Luz',
                    categoria: 'Fijos',
                    monto: 12000,
                    pagado: true
                }
            ],
            '2026-04': []
        };
    });

    it('pasarGastoAlAnterior mueve gasto pendiente al mes anterior conservando grupoId y trazabilidad', () => {
        pasarGastoAlAnterior('g1');

        expect(mockDb.gastos['2026-03'].some(g => g.id === 'g1')).toBe(false);
        expect(mockDb.gastos['2026-02']).toHaveLength(1);
        expect(mockDb.gastos['2026-02'][0]).toMatchObject({
            id: 'g1',
            concepto: 'Seguro Auto',
            grupoId: 'grp-1',
            pagado: false,
            origenMes: '2026-03',
            cadenaOrigen: '2026-03'
        });
    });

    it('pasarGastoAlAnterior no mueve gastos pagados', () => {
        pasarGastoAlAnterior('g2');

        expect(mockDb.gastos['2026-03'].some(g => g.id === 'g2')).toBe(true);
        expect(mockDb.gastos['2026-02']).toHaveLength(0);
    });

    it('deshacerRollover devuelve el gasto al mes de origen conservando grupoId', () => {
        pasarGastoAlAnterior('g1');
        mockDb.mesActivo = '2026-02';

        deshacerRollover('g1');

        expect(mockDb.gastos['2026-02']).toHaveLength(0);
        expect(mockDb.gastos['2026-03'].some(g => g.id === 'g1')).toBe(true);
        const restaurado = mockDb.gastos['2026-03'].find(g => g.id === 'g1');
        expect(restaurado.grupoId).toBe('grp-1');
        expect(restaurado.origenMes).toBeUndefined();
    });

    it('pasarGastoAlSiguiente conserva grupoId si existe', () => {
        pasarGastoAlSiguiente('g1');

        expect(mockDb.gastos['2026-04']).toHaveLength(1);
        expect(mockDb.gastos['2026-04'][0].grupoId).toBe('grp-1');
    });
});
