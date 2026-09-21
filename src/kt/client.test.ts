import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { baseUnitOf, formatCzechDate, parseCzechNumber, parseUnitOptions } from './client.js';

test('parses Czech decimal commas', () => {
  assert.equal(parseCzechNumber('20,43'), 20.43);
  assert.equal(parseCzechNumber('0,56'), 0.56);
  assert.equal(parseCzechNumber('249'), 249);
});

test('strips the thousands separator, including the non-breaking space the site emits', () => {
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 021,35'), 1021.35);
});

test('passes numbers through and rejects non-finite ones', () => {
  assert.equal(parseCzechNumber(17), 17);
  assert.equal(parseCzechNumber(Number.NaN), null);
  assert.equal(parseCzechNumber(Number.POSITIVE_INFINITY), null);
});

test('returns null rather than a misleading zero for absent values', () => {
  assert.equal(parseCzechNumber(null), null);
  assert.equal(parseCzechNumber(undefined), null);
  assert.equal(parseCzechNumber(''), null);
  assert.equal(parseCzechNumber('   '), null);
  assert.equal(parseCzechNumber('n/a'), null);
});

test('formats dates the way the site expects', () => {
  assert.equal(formatCzechDate(new Date(2026, 7, 2)), '02.08.2026');
  assert.equal(formatCzechDate(new Date(2026, 11, 25)), '25.12.2026');
});

// A trimmed copy of the detail form for "voda čistá": drinks count in
// millilitres, and the gram unit is simply not on offer.
const WATER_FORM = {
  guid: '73a02350d55a3f8f',
  unitGuid: '0000000000000002',
  unitOptions: [
    { id: 'b8346abd4ad1086b', title: 'sklenice (250 ml)', multiplier: '250' },
    { id: 'ce92276e8f8aaa95', title: 'velká sklenice (500 ml)', multiplier: '500' },
    { id: '0000000000000002', title: '1 ml', multiplier: null },
  ],
};

test('reads a food\'s unit options, base unit included', () => {
  assert.deepEqual(parseUnitOptions(WATER_FORM), [
    { id: 'b8346abd4ad1086b', title: 'sklenice (250 ml)', grams: 250 },
    { id: 'ce92276e8f8aaa95', title: 'velká sklenice (500 ml)', grams: 500 },
    { id: '0000000000000002', title: '1 ml', grams: 0 },
  ]);
});

test('defaults drinks to millilitres, because they have no gram unit', () => {
  assert.equal(baseUnitOf(parseUnitOptions(WATER_FORM)), '0000000000000002');
  // Solid food keeps grams.
  assert.equal(
    baseUnitOf([
      { id: '070757c1187a4df08d739107bb791877', title: 'kus (20 g)', grams: 20 },
      { id: '0000000000000001', title: '1 g', grams: 1 },
    ]),
    '0000000000000001',
  );
});
