import { describe, it, expect } from 'vitest';
import { claveOrdenGasto, replicarOrdenGastosHaciaAdelante } from '../js/negocio/orden-gastos.js';

describe('claveOrdenGasto', () => {
    it('genera clave normalizada por categoría y concepto para gastos fijos y únicos', () => {
        expect(claveOrdenGasto({ categoria: 'Fijos', concepto: '  Luz Eléctrica ' }))
            .toBe('fijos|luz electrica');
        expect(claveOrdenGasto({ categoria: 'Únicos', concepto: 'Médico' }))
            .toBe('unicos|medico');
    });

    it('empareja cuotas por grupoId o por concepto base cuando no hay grupoId', () => {
        expect(claveOrdenGasto({
            categoria: 'Cuotas',
            concepto: 'Heladera (Cuota 1/6)',
            grupoId: 'plan-heladera-2026-04'
        })).toBe('cuotas|grupo:plan-heladera-2026-04');

        expect(claveOrdenGasto({
            categoria: 'Cuotas',
            concepto: 'Notebook (Cuota 1/12)'
        })).toBe('cuotas|base:notebook');

        expect(claveOrdenGasto({
            categoria: 'Cuotas',
            concepto: 'Notebook (Cuota 2/12)'
        })).toBe('cuotas|base:notebook');
    });

    it('devuelve cadena vacía ante entradas nulas, primitivas, arrays o sin categoría/concepto válido', () => {
        expect(claveOrdenGasto(null)).toBe('');
        expect(claveOrdenGasto(undefined)).toBe('');
        expect(claveOrdenGasto('Luz')).toBe('');
        expect(claveOrdenGasto([])).toBe('');
        expect(claveOrdenGasto({ categoria: '   ', concepto: 'Luz' })).toBe('');
        expect(claveOrdenGasto({ categoria: null, concepto: 'Luz' })).toBe('');
        expect(claveOrdenGasto({ categoria: 'Fijos', concepto: '   ' })).toBe('');
        expect(claveOrdenGasto({ categoria: 'Cuotas', concepto: '   ', grupoId: '   ' })).toBe('');
    });
});

describe('replicarOrdenGastosHaciaAdelante', () => {
    it('replica el reordenamiento de gastos fijos hacia todos los meses futuros (mes > mesActual)', () => {
        const gastosPorMes = {
            '2026-04': [
                { id: 'abr-agua', concepto: 'Agua', categoria: 'Fijos', monto: 10000 },
                { id: 'abr-luz', concepto: 'Luz', categoria: 'Fijos', monto: 20000 },
                { id: 'abr-gas', concepto: 'Gas', categoria: 'Fijos', monto: 15000 }
            ],
            '2026-05': [
                { id: 'may-luz', concepto: 'Luz', categoria: 'Fijos', monto: 21000 },
                { id: 'may-gas', concepto: 'Gas', categoria: 'Fijos', monto: 16000 },
                { id: 'may-agua', concepto: 'Agua', categoria: 'Fijos', monto: 11000 }
            ],
            '2026-06': [
                { id: 'jun-gas', concepto: 'Gas', categoria: 'Fijos', monto: 17000 },
                { id: 'jun-luz', concepto: 'Luz', categoria: 'Fijos', monto: 22000 },
                { id: 'jun-agua', concepto: 'Agua', categoria: 'Fijos', monto: 12000 }
            ]
        };

        const refMayo = gastosPorMes['2026-05'];
        const resultado = replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');

        expect(resultado).toEqual({ mesesReordenados: 2 });
        expect(gastosPorMes['2026-05']).toBe(refMayo); // mutación in-place del mismo array
        expect(gastosPorMes['2026-05'].map(g => g.id)).toEqual(['may-agua', 'may-luz', 'may-gas']);
        expect(gastosPorMes['2026-06'].map(g => g.id)).toEqual(['jun-agua', 'jun-luz', 'jun-gas']);
    });

    it('mantiene intocables los meses anteriores (mes < mesActual)', () => {
        const marzoOriginal = [
            { id: 'mar-luz', concepto: 'Luz', categoria: 'Fijos', monto: 18000 },
            { id: 'mar-agua', concepto: 'Agua', categoria: 'Fijos', monto: 9000 }
        ];
        const gastosPorMes = {
            '2026-03': marzoOriginal.slice(),
            '2026-04': [
                { id: 'abr-agua', concepto: 'Agua', categoria: 'Fijos', monto: 10000 },
                { id: 'abr-luz', concepto: 'Luz', categoria: 'Fijos', monto: 20000 }
            ],
            '2026-05': [
                { id: 'may-luz', concepto: 'Luz', categoria: 'Fijos', monto: 21000 },
                { id: 'may-agua', concepto: 'Agua', categoria: 'Fijos', monto: 11000 }
            ]
        };

        replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');

        expect(gastosPorMes['2026-03'].map(g => g.id)).toEqual(['mar-luz', 'mar-agua']);
        expect(gastosPorMes['2026-05'].map(g => g.id)).toEqual(['may-agua', 'may-luz']);
    });

    it('reordena planes de cuotas en meses futuros compartiendo grupoId o concepto base', () => {
        const gastosPorMes = {
            '2026-04': [
                { id: 'abr-tv', concepto: 'Smart TV (Cuota 1/6)', categoria: 'Cuotas', grupoId: 'plan-tv' },
                { id: 'abr- sill', concepto: 'Sillón (Cuota 1/3)', categoria: 'Cuotas' },
                { id: 'abr-hel', concepto: 'Heladera (Cuota 1/6)', categoria: 'Cuotas', grupoId: 'plan-hel' }
            ],
            '2026-05': [
                { id: 'may-hel', concepto: 'Heladera (Cuota 2/6)', categoria: 'Cuotas', grupoId: 'plan-hel' },
                { id: 'may-tv', concepto: 'Smart TV (Cuota 2/6)', categoria: 'Cuotas', grupoId: 'plan-tv' },
                { id: 'may-sill', concepto: 'Sillón (Cuota 2/3)', categoria: 'Cuotas' }
            ]
        };

        const resultado = replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');

        expect(resultado).toEqual({ mesesReordenados: 1 });
        expect(gastosPorMes['2026-05'].map(g => g.id)).toEqual(['may-tv', 'may-sill', 'may-hel']);
    });

    it('preserva la posición de gastos exclusivos del mes futuro y conserva intactos id, monto, pagado y desestimado', () => {
        const itemLuzMayo = { id: 'may-luz', concepto: 'Luz', categoria: 'Fijos', monto: 25000, pagado: true, desestimado: false };
        const itemExclusivoMayo = { id: 'may-exp-extra', concepto: 'Expensa Extraordinaria', categoria: 'Fijos', monto: 50000, pagado: false, desestimado: true };
        const itemAguaMayo = { id: 'may-agua', concepto: 'Agua', categoria: 'Fijos', monto: 12000, pagado: false, desestimado: false };

        const gastosPorMes = {
            '2026-04': [
                { id: 'abr-agua', concepto: 'Agua', categoria: 'Fijos', monto: 10000, pagado: true, desestimado: false },
                { id: 'abr-luz', concepto: 'Luz', categoria: 'Fijos', monto: 20000, pagado: false, desestimado: true }
            ],
            '2026-05': [
                itemLuzMayo,
                itemExclusivoMayo,
                itemAguaMayo
            ]
        };

        replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');

        expect(gastosPorMes['2026-05']).toEqual([
            itemAguaMayo,
            itemExclusivoMayo,
            itemLuzMayo
        ]);
        expect(gastosPorMes['2026-05'][0]).toBe(itemAguaMayo);
        expect(gastosPorMes['2026-05'][1]).toBe(itemExclusivoMayo);
        expect(gastosPorMes['2026-05'][2]).toBe(itemLuzMayo);
        expect(itemLuzMayo).toEqual({
            id: 'may-luz',
            concepto: 'Luz',
            categoria: 'Fijos',
            monto: 25000,
            pagado: true,
            desestimado: false
        });
        expect(itemExclusivoMayo).toEqual({
            id: 'may-exp-extra',
            concepto: 'Expensa Extraordinaria',
            categoria: 'Fijos',
            monto: 50000,
            pagado: false,
            desestimado: true
        });
    });

    it('respeta las ranuras de cada categoría cuando el mes futuro intercala fijos, únicos y cuotas', () => {
        const gastosPorMes = {
            '2026-04': [
                { id: 'abr-f2', concepto: 'Gas', categoria: 'Fijos' },
                { id: 'abr-f1', concepto: 'Agua', categoria: 'Fijos' },
                { id: 'abr-c2', concepto: 'Sillón (Cuota 1/3)', categoria: 'Cuotas', grupoId: 'g-sillon' },
                { id: 'abr-c1', concepto: 'TV (Cuota 1/3)', categoria: 'Cuotas', grupoId: 'g-tv' }
            ],
            '2026-05': [
                { id: 'may-f1', concepto: 'Agua', categoria: 'Fijos' },
                { id: 'may-u1', concepto: 'Médico', categoria: 'Únicos' },
                { id: 'may-c1', concepto: 'TV (Cuota 2/3)', categoria: 'Cuotas', grupoId: 'g-tv' },
                { id: 'may-f2', concepto: 'Gas', categoria: 'Fijos' },
                { id: 'may-c2', concepto: 'Sillón (Cuota 2/3)', categoria: 'Cuotas', grupoId: 'g-sillon' }
            ]
        };

        const resultado = replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');

        expect(resultado).toEqual({ mesesReordenados: 1 });
        expect(gastosPorMes['2026-05'].map(g => g.id)).toEqual([
            'may-f2',
            'may-u1',
            'may-c2',
            'may-f1',
            'may-c1'
        ]);
    });

    it('desempata de forma estable conceptos homónimos en el mes futuro y no reporta cambios si ya está ordenado', () => {
        const dupA = { id: 'may-luz-1', concepto: 'Luz', categoria: 'Fijos', monto: 10000 };
        const dupB = { id: 'may-luz-2', concepto: 'Luz', categoria: 'Fijos', monto: 15000 };
        const agua = { id: 'may-agua', concepto: 'Agua', categoria: 'Fijos', monto: 8000 };

        const gastosPorMes = {
            '2026-04': [
                { id: 'abr-agua', concepto: 'Agua', categoria: 'Fijos' },
                { id: 'abr-luz', concepto: 'Luz', categoria: 'Fijos' }
            ],
            '2026-05': [dupA, dupB, agua]
        };

        const primeraPasada = replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');
        expect(primeraPasada).toEqual({ mesesReordenados: 1 });
        expect(gastosPorMes['2026-05']).toEqual([agua, dupA, dupB]);

        // Segunda pasada idempotente: ya está en el orden esperado
        const segundaPasada = replicarOrdenGastosHaciaAdelante(gastosPorMes, '2026-04');
        expect(segundaPasada).toEqual({ mesesReordenados: 0 });
    });

    it('tolera entradas nulas, meses corruptos o elementos inválidos sin lanzar excepciones', () => {
        expect(replicarOrdenGastosHaciaAdelante(null, '2026-04')).toEqual({ mesesReordenados: 0 });
        expect(replicarOrdenGastosHaciaAdelante({}, '')).toEqual({ mesesReordenados: 0 });
        expect(replicarOrdenGastosHaciaAdelante({ '2026-04': null }, '2026-04')).toEqual({ mesesReordenados: 0 });

        const gastosConBasura = {
            '2026-04': [
                null,
                { id: 'abr-agua', concepto: 'Agua', categoria: 'Fijos' },
                undefined,
                { id: 'abr-luz', concepto: 'Luz', categoria: 'Fijos' }
            ],
            '2026-05': null,
            '2026-06': [
                { id: 'jun-luz', concepto: 'Luz', categoria: 'Fijos' },
                null,
                { id: 'jun-agua', concepto: 'Agua', categoria: 'Fijos' }
            ]
        };

        expect(replicarOrdenGastosHaciaAdelante(gastosConBasura, '2026-04')).toEqual({ mesesReordenados: 1 });
        expect(gastosConBasura['2026-06'].map(g => g && g.id)).toEqual(['jun-agua', null, 'jun-luz']);
    });
});
