import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(){this.map=new Map();}
  getItem(k){return this.map.has(k)?this.map.get(k):null;}
  setItem(k,v){this.map.set(k,String(v));}
  removeItem(k){this.map.delete(k);}
}
globalThis.localStorage = new MemoryStorage();

const { saveData, loadData, normalizeData } = await import('../src/storage.js');

test('guardado local conserva socios, pagos, productos y ventas nuevos', () => {
  const d=normalizeData({datasetId:'north-south-academy-main',settings:{defaultFee:2500},members:[],payments:[],products:[],sales:[]});
  d.members.push({id:'m-new',firstName:'NUEVO',displayName:'NUEVO',status:'active',feeMode:'default',feeStartPeriod:'2026-08',feeHistory:[],updatedAt:'2026-08-07T10:00:00Z',deletedAt:null});
  d.payments.push({id:'p-new',memberId:'m-new',period:'2026-08',amount:2500,createdAt:'2026-08-07T10:01:00Z',updatedAt:'2026-08-07T10:01:00Z',deletedAt:null});
  d.products.push({id:'prod-new',name:'LICUADO',emoji:'🥤',price:150,active:true,createdAt:'2026-08-07T10:02:00Z',updatedAt:'2026-08-07T10:02:00Z',deletedAt:null});
  d.sales.push({id:'sale-new',memberId:'m-new',productId:'prod-new',quantity:1,unitPrice:150,amount:150,soldAt:'2026-08-07',createdAt:'2026-08-07T10:03:00Z',updatedAt:'2026-08-07T10:03:00Z',deletedAt:null});
  saveData(d);
  const loaded=loadData();
  assert.ok(loaded.members.some(x=>x.id==='m-new'));
  assert.ok(loaded.payments.some(x=>x.id==='p-new'));
  assert.ok(loaded.products.some(x=>x.id==='prod-new'&&x.emoji==='🥤'));
  assert.ok(loaded.sales.some(x=>x.id==='sale-new'));
});


test('el estado inactivo de un producto también queda guardado localmente', () => {
  const d=loadData();
  const existing=d.products.find(x=>x.id==='prod-new');
  if(existing){existing.active=false;existing.updatedAt='2026-08-07T11:00:00Z';}
  else d.products.push({id:'prod-new',name:'LICUADO',emoji:'🥤',price:150,active:false,createdAt:'2026-08-07T10:02:00Z',updatedAt:'2026-08-07T11:00:00Z',deletedAt:null});
  saveData(d);
  assert.equal(loadData().products.find(x=>x.id==='prod-new')?.active,false);
});
