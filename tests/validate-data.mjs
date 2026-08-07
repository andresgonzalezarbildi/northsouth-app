import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../data.js", import.meta.url), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);
const data = context.window.PLAN_DATA;

assert.ok(data);
assert.equal(data.version, "2026.08.07-13");
assert.ok(Array.isArray(data.items));
assert.ok(data.items.length > 200);

const ids = data.items.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, "Los IDs deben ser únicos");
assert.ok(data.items.every((item) => data.subjects[item.subject]), "Todas las materias deben existir");
assert.ok(data.items.every((item) => !item.week || /^\d{4}-\d{2}-\d{2}$/.test(item.week)), "Semanas inválidas");
assert.ok(data.items.every((item) => !/sugerencia|preparar|repaso para/i.test(`${item.source} ${item.title}`)), "No debe haber bloques de estudio inventados");
assert.ok(data.items.every((item) => !Object.hasOwn(item, "minutes")), "No debe haber duraciones sugeridas");

const redesW1 = data.items.filter((item) => item.subject === "redes" && item.week === "2026-08-03");
for (const n of [1, 2, 3]) {
  assert.ok(redesW1.some((item) => item.type === "openfing" && item.title === `Clase OpenFing ${n}`));
}
assert.ok(redesW1.some((item) => item.type === "reading" && item.title === "Capítulo 1"));
assert.ok(redesW1.some((item) => item.type === "practical" && item.title === "P1 · Retardos"));
assert.ok(!redesW1.some((item) => item.title === "Presentación del curso y repaso de introducción"));
assert.ok(!redesW1.some((item) => item.title === "Práctico 1"));
assert.equal(redesW1.filter((item) => item.type === "practical").length, 1, "La semana 1 de Redes debe tener un solo práctico");


assert.ok(!data.items.some((item) => item.type === "discussion"), "No deben quedar tarjetas de discusión");
assert.ok(!data.items.some((item) => item.type === "consultation"), "No deben quedar tarjetas de consulta");
assert.ok(!data.items.some((item) => ["holiday", "no-class", "notice"].includes(item.type)), "No deben quedar avisos administrativos de poco valor");
assert.ok(!data.items.some((item) => item.subject === "redes" && item.type === "course-class" && item.details === "Actividad de clase indicada en el cronograma"), "No deben quedar actividades de clase redundantes en Redes");

const fbd = data.items.filter((item) => item.subject === "fbd");
assert.ok(fbd.length > 40);
assert.ok(fbd.every((item) => item.week));
assert.ok(fbd.every((item) => item.periodLabel));
assert.ok(!fbd.some((item) => item.id.startsWith("fbd-undated")));

const fbdW1 = fbd.filter((item) => item.week === "2026-08-03");
assert.ok(fbdW1.some((item) => item.title === "Introducción"));
assert.ok(fbdW1.some((item) => item.title === "Diseño Conceptual"));
assert.ok(fbdW1.some((item) => item.title === "Video OpenFing 1" && /16:43/.test(item.details)));
assert.ok(fbdW1.some((item) => item.title === "Video OpenFing 2"));
assert.ok(!fbdW1.some((item) => item.title === "Presentación del curso"));

const partials = fbd.filter((item) => item.title === "Parciales");
assert.equal(partials.length, 1, "El período conjunto no debe separarse artificialmente");
assert.equal(partials[0].periodLabel, "Semanas 8 y 9 · 19/09–03/10");

const repeatedVideos = fbd.filter((item) => ["Video OpenFing 13", "Video OpenFing 14"].includes(item.title));
assert.equal(repeatedVideos.length, 4, "Los videos 13 y 14 deben figurar en semanas 7 y 10");

const pln = data.items.filter((item) => item.subject === "pln");
assert.equal(pln.filter((item) => item.type === "openfing").length, 20, "Deben existir las 20 clases OpenFing de IntroPLN");
assert.ok(pln.every((item) => !item.week), "IntroPLN no debe asignarse a semanas sin cronograma oficial");
assert.ok(pln.some((item) => item.title === "Clase OpenFing 1 · Introducción al Procesamiento de Lenguaje Natural"));
assert.ok(pln.some((item) => item.title === "Clase OpenFing 20 · Recuperación de Información"));
assert.ok(pln.filter((item) => item.type === "openfing").every((item) => item.source === "OpenFing"));
assert.ok(!/Creative Commons/i.test(source));

console.log(`OK: ${data.items.length} elementos validados`);
