import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assertWeightKg,
  baseUnitOf,
  czechDateFromEpoch,
  formatCzechDate,
  parseCzechNumber,
  parseDiaryDay,
  parseLoggedDays,
  parsePeriodAnalysis,
  parseUnitOptions,
} from './client.js';

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

// Fixtures are trimmed copies of real responses; the site's own field names
// and Czech number formatting are the point of these tests.
const DAY_FIXTURE = {
  date: 1789768800000,
  energyUnit: 'kcal',
  times: [
    {
      id: '1',
      title: 'Snídaně',
      energyTotal: '329,6',
      foodstuff: [
        {
          id: '558a6bc697a14cb996fbfcef5170ee68',
          type: 'foodstuff',
          guidType: 'c48fca3fc69bbcb8',
          title: 'Toustový chléb',
          unit: '3 x kus (20 g)',
          energy: '144',
          energyUnit: 'kcal',
          protein: 4.2,
          carbohydrate: 31.2,
          fat: 1.5,
          fiber: 0.6,
          sugar: null,
        },
        {
          id: 'b0b0',
          type: 'foodstuff',
          guidType: 'd10ffdda00be195b',
          title: 'banán',
          unit: 'kus (90 g)',
          energy: '84,6',
          protein: 1.08,
          carbohydrate: 19.8,
          fat: 0.18,
          fiber: 1.8,
          sugar: 17.1,
        },
      ],
    },
    { id: '2', title: 'Dopolední svačina', energyTotal: null, foodstuff: [] },
  ],
  activities: [{ id: 'a1', type: 'activity', title: 'Garmin aktivita (Kroky)', energy: '1 113' }],
  notes: [],
  // The day payload reports its own totals as zeroes, which is why we sum.
  energyTotal: 0,
  proteinTotal: 0,
};

test('reads a diary day, entry by entry', () => {
  const day = parseDiaryDay(DAY_FIXTURE, '19.09.2026');
  assert.equal(day.date, '19.09.2026');
  assert.equal(day.meals.length, 2);
  assert.deepEqual(
    day.meals[0]?.entries.map(e => [e.title, e.amount, e.energy]),
    [
      ['Toustový chléb', '3 x kus (20 g)', 144],
      ['banán', 'kus (90 g)', 84.6],
    ],
  );
  // entryId identifies the diary row, foodId the food — they are different ids.
  assert.equal(day.meals[0]?.entries[0]?.entryId, '558a6bc697a14cb996fbfcef5170ee68');
  assert.equal(day.meals[0]?.entries[0]?.foodId, 'c48fca3fc69bbcb8');
  assert.equal(day.meals[1]?.entries.length, 0);
  assert.deepEqual(day.activities, [{ entryId: 'a1', title: 'Garmin aktivita (Kroky)', energy: 1113 }]);
});

test('totals a day from its entries, not from the zeroed totals the site sends', () => {
  const { totals } = parseDiaryDay(DAY_FIXTURE, '19.09.2026');
  assert.equal(totals.energy, 228.6);
  assert.equal(totals.protein, 5.28);
  assert.equal(totals.carbs, 51);
  assert.equal(totals.sugar, 17.1); // one entry has none; the other still counts
});

test('rejects a day payload that lost its meal slots', () => {
  assert.throws(() => parseDiaryDay({ energyUnit: 'kcal' }, '19.09.2026'), /expected a day with meal slots/);
});

test('normalises the two colour-class prefixes the calendar uses', () => {
  const days = parseLoggedDays([
    { date: '1789768800000', colorClass: 'cc-good' },
    { date: 1789855200000, colorClass: 'calendar-low' },
    { date: '1789941600000', colorClass: null },
    { date: null, colorClass: 'cc-good' },
  ]);
  assert.deepEqual(days, [
    { date: '19.09.2026', status: 'good' },
    { date: '20.09.2026', status: 'low' },
    { date: '21.09.2026', status: null },
  ]);
});

test('renders diary timestamps in Czech time, not the container\'s', () => {
  // Czech midnight on 20.09.2026 is 22:00 UTC the day before.
  assert.equal(czechDateFromEpoch(1789855200000), '20.09.2026');
  assert.equal(czechDateFromEpoch('1789855200000'), '20.09.2026');
  assert.equal(czechDateFromEpoch(null), null);
  assert.equal(czechDateFromEpoch('not a date'), null);
});

test('reads a period as per-day averages, and says when days are missing', () => {
  const analysis = parsePeriodAnalysis(
    {
      recordsMissing: true,
      energy: { title: 'Energetická hodnota', value: 1458.1, target: 2464, percent: 59, energyUnit: 'kcal' },
      list: [
        { title: 'Bílkoviny', value: 47.17, target: 169.92, percent: 28 },
        { title: 'Sacharidy', value: 96.75, target: 260.95, percent: 37 },
      ],
      salt: { title: 'Sůl', value: 2.55, target: 5, percent: 51 },
      drink: { title: null, value: 0.05, target: 3.33, percent: 1 },
      totalValueInfluence: [
        {
          title: 'Energetická hodnota',
          items: [
            { id: '598ba5dc2d704090', title: 'Pizza Diavola', valueString: '138 kcal', count: '2x' },
            { id: null, title: 'Tortilka', valueString: '102 kcal', count: '5x' },
          ],
        },
        { title: 'Vláknina', items: [{ id: null, title: 'Granola', valueString: '1,1 g', count: '12x' }] },
      ],
      totalValueInfluenceCategory: [
        { title: 'Energetická hodnota', items: [{ title: 'Fast food', valueString: '154 kcal', count: null }] },
      ],
    },
    '18.09.2026',
    '19.09.2026',
  );
  assert.equal(analysis.days, 2);
  assert.equal(analysis.someDaysWithoutRecords, true);
  assert.equal(analysis.energy.perDay, 1458.1);
  assert.deepEqual(analysis.nutrients.map(n => n.title), ['Bílkoviny', 'Sacharidy']);
  assert.equal(analysis.drink?.title, 'Pitný režim'); // the site sends no title for it
});

test('ranks the foods behind each nutrient, with how often each was logged', () => {
  const analysis = parsePeriodAnalysis(
    {
      energy: { value: 1, target: 1, percent: 1 },
      list: [],
      totalValueInfluence: [
        {
          title: 'Energetická hodnota',
          items: [
            { id: '598ba5dc2d704090', title: 'Pizza Diavola', valueString: '138 kcal', count: '2x' },
            { id: null, title: 'Tortilka', valueString: '102 kcal', count: '5x' },
          ],
        },
        { title: 'Vláknina', items: [{ id: null, title: 'Granola', valueString: '1,1 g', count: '12x' }] },
      ],
      totalValueInfluenceCategory: [
        { title: 'Energetická hodnota', items: [{ title: 'Fast food', valueString: '154 kcal', count: null }] },
      ],
    },
    '21.08.2026',
    '20.09.2026',
  );
  assert.deepEqual(analysis.topFoods[0]?.items[0], {
    title: 'Pizza Diavola',
    foodId: '598ba5dc2d704090',
    perDay: 138,
    unit: 'kcal',
    timesLogged: 2,
  });
  // Grams, a decimal comma, and a category row that carries no count at all.
  assert.deepEqual(analysis.topFoods[1]?.items[0], {
    title: 'Granola',
    foodId: null,
    perDay: 1.1,
    unit: 'g',
    timesLogged: 12,
  });
  assert.equal(analysis.topCategories[0]?.items[0]?.title, 'Fast food');
  assert.equal(analysis.topCategories[0]?.items[0]?.timesLogged, null);
});

test('survives an analysis with no rankings at all', () => {
  const analysis = parsePeriodAnalysis({ energy: { value: 1 }, list: [] }, '01.09.2026', '02.09.2026');
  assert.deepEqual(analysis.topFoods, []);
  assert.deepEqual(analysis.topCategories, []);
});

test('counts days across a month boundary', () => {
  const analysis = parsePeriodAnalysis(
    { energy: { value: 1, target: 1, percent: 1 }, list: [] },
    '28.02.2027',
    '02.03.2027',
  );
  assert.equal(analysis.days, 3);
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

test('accepts realistic body weights in kilograms', () => {
  assert.equal(assertWeightKg(20), 20);
  assert.equal(assertWeightKg(103.3), 103.3);
  assert.equal(assertWeightKg(500), 500);
});

test('rejects implausible or non-finite body weights', () => {
  assert.throws(() => assertWeightKg(0), /between 20 and 500/);
  assert.throws(() => assertWeightKg(501), /between 20 and 500/);
  assert.throws(() => assertWeightKg(Number.NaN), /between 20 and 500/);
});
