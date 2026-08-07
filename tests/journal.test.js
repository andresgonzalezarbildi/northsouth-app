import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperation, applyOperations, mergeOperations } from '../src/journal.js';
import { normalizeData } from '../src/storage.js';

function baseData() {
  return normalizeData({
    datasetId:'north-south-academy-main',
    settings:{defaultFee:2500,updatedAt:'2026-08-07T10:00:00Z'},
    members:[{id:'m1',firstName:'ANA',displayName:'ANA',status:'active',feeMode:'default',monthlyFee:2500,feeStartPeriod:'2026-08',feeHistory:[],createdAt:'2026-08-07T10:00:00Z',updatedAt:'2026-08-07T10:00:00Z',deletedAt:null}],
    payments:[],
    products:[{id:'prod-kimono',name:'KIMONO',emoji:'🥋',price:2500,active:true,createdAt:'2026-08-07T10:00:00Z',updatedAt:'2026-08-07T10:00:00Z',deletedAt:null}],
    sales:[],operations:[],meta:{updatedAt:'2026-08-07T10:00:00Z'}
  });
}

test('dos equipos pueden registrar operaciones distintas sin perder ninguna', () => {
  const base = baseData();
  const a = structuredClone(base);
  a.payments.push({id:'p-a',memberId:'m1',period:'2026-08',amount:2500,method:'cash',paidAt:'2026-08-07T12:00:00',createdAt:'2026-08-07T12:00:00Z',updatedAt:'2026-08-07T12:00:00Z',deletedAt:null});
  const opA = createOperation(base,a,{id:'op-a',deviceId:'pc-a',createdAt:'2026-08-07T12:00:00Z',label:'Pago guardado.'});

  const b = structuredClone(base);
  b.products[0].deletedAt='2026-08-07T12:00:01Z';
  b.products[0].updatedAt='2026-08-07T12:00:01Z';
  const opB = createOperation(base,b,{id:'op-b',deviceId:'pc-b',createdAt:'2026-08-07T12:00:01Z',label:'Producto eliminado.'});

  const operations = mergeOperations([opA],[opB]);
  const merged = applyOperations(base, operations);
  assert.equal(operations.length,2);
  assert.ok(merged.payments.some(p=>p.id==='p-a'&&!p.deletedAt));
  assert.ok(merged.products.find(p=>p.id==='prod-kimono').deletedAt);
});

test('reaplicar una operación no duplica pagos', () => {
  const base = baseData();
  const changed = structuredClone(base);
  changed.payments.push({id:'p-1',memberId:'m1',period:'2026-08',amount:1000,createdAt:'2026-08-07T12:00:00Z',updatedAt:'2026-08-07T12:00:00Z',deletedAt:null});
  const op = createOperation(base,changed,{id:'op-1',deviceId:'pc-a',createdAt:'2026-08-07T12:00:00Z'});
  const merged = applyOperations(base,[op,op]);
  assert.equal(merged.payments.filter(p=>p.id==='p-1').length,1);
});

test('un borrado queda registrado como tombstone dentro del log', () => {
  const base = baseData();
  const changed = structuredClone(base);
  changed.products[0].deletedAt='2026-08-07T13:00:00Z';
  changed.products[0].updatedAt='2026-08-07T13:00:00Z';
  const op = createOperation(base,changed,{id:'op-delete',deviceId:'pc-a',createdAt:'2026-08-07T13:00:00Z'});
  assert.equal(op.changes.length,1);
  assert.equal(op.changes[0].collection,'products');
  assert.equal(op.changes[0].record.deletedAt,'2026-08-07T13:00:00Z');
});
