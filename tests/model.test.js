import test from 'node:test';
import assert from 'node:assert/strict';
import {
  memberFee, memberPeriodStatus, periodSummary, validatePayment, recentMovements, findMembers
} from '../src/model.js';

const base = () => ({
  settings:{defaultFee:3000,currency:'UYU',lastPaymentMethod:'cash',updatedAt:'2026-08-01T00:00:00Z',feeHistory:[
    {id:'f1',effectiveFrom:'1900-01',amount:2500,updatedAt:'2026-01-01T00:00:00Z',deletedAt:null},
    {id:'f2',effectiveFrom:'2026-08',amount:3000,updatedAt:'2026-08-01T00:00:00Z',deletedAt:null}
  ]},
  members:[
    {id:'m1',displayName:'ANDRES',status:'active',feeMode:'default',monthlyFee:3000,feeHistory:[],feeStartPeriod:'1900-01',updatedAt:'2026-08-01T00:00:00Z',deletedAt:null},
    {id:'m2',displayName:'DOS',status:'active',feeMode:'custom',monthlyFee:2000,feeHistory:[{id:'mf1',effectiveFrom:'1900-01',amount:2000,updatedAt:'2026-01-01T00:00:00Z',deletedAt:null}],feeStartPeriod:'1900-01',updatedAt:'2026-08-01T00:00:00Z',deletedAt:null},
    {id:'m3',displayName:'TRES',status:'inactive',feeMode:'default',monthlyFee:3000,feeHistory:[],feeStartPeriod:'1900-01',updatedAt:'2026-08-01T00:00:00Z',deletedAt:null}
  ],
  payments:[
    {id:'p1',memberId:'m1',period:'2026-08',amount:1000,method:'cash',paidAt:'2026-08-01T12:00:00',createdAt:'2026-08-07T10:00:00Z',updatedAt:'2026-08-07T10:00:00Z',deletedAt:null},
    {id:'p2',memberId:'m1',period:'2026-08',amount:2000,method:'transfer',paidAt:'2026-08-02T12:00:00',createdAt:'2026-08-07T10:01:00Z',updatedAt:'2026-08-07T10:01:00Z',deletedAt:null},
    {id:'p3',memberId:'m3',period:'2026-08',amount:3000,method:'cash',paidAt:'2026-08-02T12:00:00',createdAt:'2026-08-07T10:02:00Z',updatedAt:'2026-08-07T10:02:00Z',deletedAt:null}
  ],
  products:[{id:'prod1',name:'ALFAJOR',emoji:'🍫',price:100,active:true,updatedAt:'2026-08-01T00:00:00Z',deletedAt:null}],
  sales:[]
});

test('estado mensual se actualiza con pagos parciales acumulados', () => {
  const d=base();
  assert.deepEqual(memberPeriodStatus(d,d.members[0],'2026-08'), {fee:3000,paid:3000,remaining:0,isPaid:true,overpaid:0,notStarted:false});
});

test('cambiar la cuota desde agosto no genera deuda hacia atrás', () => {
  const d=base();
  assert.equal(memberFee(d,d.members[0],'2026-07'),2500);
  assert.equal(memberFee(d,d.members[0],'2026-08'),3000);
});

test('la cuota especial no cambia con la cuota general', () => {
  const d=base();
  assert.equal(memberFee(d,d.members[1],'2026-07'),2000);
  assert.equal(memberFee(d,d.members[1],'2026-08'),2000);
});

test('resumen usa solo socios activos para el esperado', () => {
  const s=periodSummary(base(),'2026-08');
  assert.equal(s.expected,5000);
  assert.equal(s.collected,6000);
  assert.equal(s.activeCount,2);
  assert.equal(s.pendingCount,1);
});

test('evita duplicar un mes ya completamente pago', () => {
  const errors=validatePayment(base(),{memberId:'m1',period:'2026-08',paidAt:'2026-08-07',amount:10,method:'cash'});
  assert.ok(errors.some(x=>x.includes('ya está pago')));
});

test('últimos movimientos se ordenan por momento de agregado y no por fecha del cobro', () => {
  const d=base();
  d.payments.push({id:'p4',memberId:'m2',period:'2026-03',amount:2000,method:'cash',paidAt:'2026-03-01T12:00:00',createdAt:'2026-08-07T11:00:00Z',updatedAt:'2026-08-07T11:00:00Z',deletedAt:null});
  assert.equal(recentMovements(d,1)[0].id,'p4');
});

test('búsqueda tolera caracteres intermedios faltantes', () => {
  const d=base();
  assert.equal(findMembers(d,'andes')[0].displayName,'ANDRES');
});
