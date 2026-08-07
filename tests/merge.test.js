import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeData } from '../src/merge.js';

function data() {
  return {
    schemaVersion:3,datasetId:'north-south-academy-main',
    settings:{academyName:'North South Academy',defaultFee:2500,currency:'UYU',lastPaymentMethod:'cash',lastSaleMethod:'cash',updatedAt:'2026-08-01T00:00:00Z',feeHistory:[{id:'f1',effectiveFrom:'1900-01',amount:2500,updatedAt:'2026-08-01T00:00:00Z',deletedAt:null}]},
    members:[{id:'m1',displayName:'UNO',status:'active',feeMode:'default',monthlyFee:2500,feeHistory:[],feeStartPeriod:'1900-01',updatedAt:'2026-08-01T00:00:00Z',deletedAt:null}],
    payments:[],products:[],sales:[],meta:{updatedAt:'2026-08-01T00:00:00Z'}
  };
}

test('merge conserva cambios nuevos de distintos dispositivos sin pisarlos', () => {
  const local=data(),remote=data();
  local.members[0].displayName='NOMBRE LOCAL';local.members[0].updatedAt='2026-08-05T10:00:00Z';
  local.payments.push({id:'p-local',memberId:'m1',period:'2026-08',amount:2500,updatedAt:'2026-08-05T10:01:00Z',deletedAt:null});
  remote.products.push({id:'prod-remote',name:'AGUA',emoji:'💧',price:80,active:true,updatedAt:'2026-08-06T10:00:00Z',deletedAt:null});
  remote.sales.push({id:'sale-remote',memberId:'m1',productId:'prod-remote',quantity:1,unitPrice:80,amount:80,soldAt:'2026-08-06',updatedAt:'2026-08-06T10:01:00Z',deletedAt:null});
  const merged=mergeData(local,remote);
  assert.equal(merged.members[0].displayName,'NOMBRE LOCAL');
  assert.ok(merged.payments.some(x=>x.id==='p-local'));
  assert.ok(merged.products.some(x=>x.id==='prod-remote'));
  assert.ok(merged.sales.some(x=>x.id==='sale-remote'));
});

test('merge propaga borrados mediante deletedAt', () => {
  const local=data(),remote=data();
  remote.members[0].deletedAt='2026-08-04T10:00:00Z';remote.members[0].updatedAt='2026-08-04T10:00:00Z';
  const merged=mergeData(local,remote);
  assert.equal(merged.members[0].deletedAt,'2026-08-04T10:00:00Z');
});

test('merge combina historial de cuotas de dos equipos', () => {
  const local=data(),remote=data();
  local.settings.feeHistory.push({id:'f2',effectiveFrom:'2026-09',amount:2800,updatedAt:'2026-08-05T10:00:00Z',deletedAt:null});
  remote.settings.feeHistory.push({id:'f3',effectiveFrom:'2027-01',amount:3000,updatedAt:'2026-08-06T10:00:00Z',deletedAt:null});
  const merged=mergeData(local,remote);
  assert.ok(merged.settings.feeHistory.some(x=>x.id==='f2'));
  assert.ok(merged.settings.feeHistory.some(x=>x.id==='f3'));
});
