/**
 * Client for the private JSON API behind www.kaloricketabulky.cz.
 *
 * The site is a Spring MVC app where any route accepts `?format=json` and
 * replies with a `{code, data, message}` envelope (`code: 0` means success).
 * Auth is a JSESSIONID cookie obtained by posting an md5 of the password.
 *
 * None of this is documented or guaranteed by Dine4Fit. Every call that
 * deviates from the shape we expect throws rather than guessing, so a
 * frontend change surfaces as a loud error instead of a wrong calorie count.
 */

import { createHash } from 'node:crypto';

const BASE = 'https://www.kaloricketabulky.cz';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** unitGuid for plain grams — accepted by every solid food. */
export const GRAM_UNIT = '0000000000000001';

/**
 * Pseudo-unit meaning "one portion of this recipe", offered only by the
 * meal-add form (alongside `0000000000000003` for percent).
 */
export const PORTION_UNIT = '0000000000000004';

/** Diary time slots, keyed by the `diaryTimeGuid` the site expects. */
export const MEALS = {
  '1': 'Snídaně',
  '2': 'Dopolední svačina',
  '3': 'Oběd',
  '4': 'Odpolední svačina',
  '5': 'Večeře',
  '6': 'Druhá večeře',
} as const;

export type MealId = keyof typeof MEALS;

export interface FoodHit {
  id: string;
  title: string;
  /** Energy per 100 g / 100 ml, as the site reports it in search results. */
  energyPer100: number | null;
  energyUnit: string;
  baseUnit: string;
  brand: string | null;
}

export interface UnitOption {
  id: string;
  title: string;
  /** Grams (or ml) that one of this unit corresponds to. */
  grams: number;
}

export interface FoodDetail {
  id: string;
  title: string;
  units: UnitOption[];
  /** The site's own default portion for this food. */
  defaultUnitId: string;
  defaultAmount: number;
}

export interface Nutrition {
  title: string;
  energy: number | null;
  energyUnit: string;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fibre: number | null;
  saturatedFat: number | null;
  salt: number | null;
}

export interface MealSummary {
  id: string;
  title: string;
  /** Energy for the whole recipe, not per portion. */
  energy: number | null;
  energyUnit: string;
  portions: number;
}

/** One row of the diary: something that was eaten, with what it contributed. */
export interface DiaryEntry {
  /** Identifies this diary row, not the food — the site calls it the diary guid. */
  entryId: string;
  /** The food's own id, the one search_food returns. Null for rows the site does not link to a food. */
  foodId: string | null;
  title: string;
  /** How much was logged, exactly as the site renders it ("3 x kus (20 g)", "120 x 1 g"). */
  amount: string;
  energy: number | null;
  energyUnit: string;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fibre: number | null;
  sugar: number | null;
  /** "foodstuff" for a plain food, "meal" for one of the user's saved recipes. */
  kind: string;
}

export interface DiaryMealSlot {
  meal: string;
  title: string;
  energy: number | null;
  entries: DiaryEntry[];
}

/** A burned-energy row (manual or synced from a tracker). */
export interface DiaryActivity {
  entryId: string;
  title: string;
  energy: number | null;
}

export interface DiaryTotals {
  energy: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fibre: number | null;
  sugar: number | null;
}

export interface DiaryDay {
  date: string;
  energyUnit: string;
  meals: DiaryMealSlot[];
  activities: DiaryActivity[];
  notes: string[];
  /**
   * Summed from the entries above, because the day payload's own *Total
   * fields come back as zeroes. get_day_summary is the site's own arithmetic.
   */
  totals: DiaryTotals;
}

export interface LoggedDay {
  date: string;
  /**
   * The site's own colour coding for the day, normalised ("good", "low", …).
   * Null means the day is in the diary but carries no rating.
   */
  status: string | null;
}

/** One nutrient in a period analysis. Values are per-day averages. */
export interface NutrientAverage {
  title: string;
  perDay: number | null;
  target: number | null;
  /** Percent of the target reached, as the site computes it. */
  percentOfTarget: number | null;
}

/** One food (or food category) in the site's "most significant" ranking. */
export interface Contributor {
  title: string;
  /** Food id where the site links one, usable with log_food. Categories have none. */
  foodId: string | null;
  /** Average contribution per day across the range. */
  perDay: number | null;
  unit: string | null;
  /** How many times it was logged over the range ("12x" on the site). */
  timesLogged: number | null;
}

/** The ranking for one nutrient: which foods contributed most of it. */
export interface ContributorGroup {
  nutrient: string;
  items: Contributor[];
}

export interface PeriodAnalysis {
  from: string;
  to: string;
  days: number;
  /** True when at least one day in the range has no records, which drags every average down. */
  someDaysWithoutRecords: boolean;
  energy: NutrientAverage;
  energyUnit: string;
  nutrients: NutrientAverage[];
  salt: NutrientAverage | null;
  drink: NutrientAverage | null;
  /** Per nutrient, the foods that contributed most of it, biggest first. */
  topFoods: ContributorGroup[];
  /** The same ranking rolled up into the site's food categories. */
  topCategories: ContributorGroup[];
}

export class KtError extends Error {}

/**
 * A food's base unit — the one whose multiplier is 1 (the site sends `null`
 * for it). Grams for solids, millilitres for liquids, and a liquid's unit list
 * does not contain the gram unit at all, so this must be read per food rather
 * than assumed.
 */
export function baseUnitOf(units: UnitOption[]): string {
  return units.find(u => u.grams === 0 || u.grams === 1)?.id ?? GRAM_UNIT;
}

/**
 * Czech number formatting: decimal comma, thin/regular space as the thousands
 * separator ("1 043", "20,43"). Returns null for absent or unparseable values
 * rather than a misleading 0.
 */
export function parseCzechNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalised = value.replace(/[\s  ]/g, '').replace(',', '.');
  if (normalised === '') return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/** The site formats dates as dd.MM.yyyy everywhere. */
export function formatCzechDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getFullYear()}`;
}

// The diary runs on Czech wall-clock time; the server usually doesn't
// (containers default to UTC, which would flip the date around midnight).
const PRAGUE_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function pragueDate(date: Date): string {
  const parts = PRAGUE_DATE.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

export function todayCzech(): string {
  return pragueDate(new Date());
}

/**
 * Diary reads carry dates as epoch milliseconds (sometimes as a string), and
 * they mark Czech midnight — so they must be rendered in that zone or a UTC
 * container shows the previous day.
 */
export function czechDateFromEpoch(value: unknown): string | null {
  const ms = typeof value === 'string' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return pragueDate(new Date(ms));
}

/**
 * Dates come from the model, and one of them ends up in a URL path, so accept
 * nothing but the site's own dd.MM.yyyy shape.
 */
export function assertCzechDate(date: string): string {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
    throw new Error(`Invalid date "${date}" — expected dd.MM.yyyy, e.g. ${todayCzech()}`);
  }
  return date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Sums a column across entries, keeping null when nothing contributed a number. */
function sum(entries: DiaryEntry[], pick: (e: DiaryEntry) => number | null): number | null {
  const values = entries.map(pick).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  // The site sends one decimal at most; re-round to keep 0.30000000000000004 out of the output.
  return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
}

function parseDiaryEntry(raw: unknown, energyUnit: string): DiaryEntry | null {
  const item = record(raw);
  const entryId = item && text(item['id']);
  if (!item || !entryId) return null;
  return {
    entryId,
    foodId: text(item['guidType']),
    title: String(item['title'] ?? ''),
    amount: String(item['unit'] ?? ''),
    energy: parseCzechNumber(item['energy']),
    energyUnit: text(item['energyUnit']) ?? energyUnit,
    protein: parseCzechNumber(item['protein']),
    carbs: parseCzechNumber(item['carbohydrate']),
    fat: parseCzechNumber(item['fat']),
    fibre: parseCzechNumber(item['fiber']),
    sugar: parseCzechNumber(item['sugar']),
    kind: text(item['type']) ?? 'foodstuff',
  };
}

/** Turns the diary-day payload into the entries, per meal, plus totals summed from them. */
export function parseDiaryDay(raw: unknown, date: string): DiaryDay {
  const day = record(raw);
  if (!day || !Array.isArray(day['times'])) throw new KtError(`diary ${date}: expected a day with meal slots`);
  const energyUnit = text(day['energyUnit']) ?? 'kcal';

  const meals: DiaryMealSlot[] = day['times']
    .map(slot => record(slot))
    .filter((slot): slot is Record<string, unknown> => slot !== null)
    .map(slot => {
      const entries = (Array.isArray(slot['foodstuff']) ? slot['foodstuff'] : [])
        .map(entry => parseDiaryEntry(entry, energyUnit))
        .filter((entry): entry is DiaryEntry => entry !== null);
      return {
        meal: String(slot['id'] ?? ''),
        title: String(slot['title'] ?? ''),
        energy: parseCzechNumber(slot['energyTotal']),
        entries,
      };
    });

  const all = meals.flatMap(m => m.entries);
  const activities = (Array.isArray(day['activities']) ? day['activities'] : [])
    .map(entry => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null && text(entry['id']) !== null)
    .map(entry => ({
      entryId: String(entry['id']),
      title: String(entry['title'] ?? ''),
      energy: parseCzechNumber(entry['energy']),
    }));
  const notes = (Array.isArray(day['notes']) ? day['notes'] : [])
    .map(note => (typeof note === 'string' ? note : text(record(note)?.['note'] ?? record(note)?.['title'])))
    .filter((note): note is string => note !== null);

  return {
    date,
    energyUnit,
    meals,
    activities,
    notes,
    totals: {
      energy: sum(all, e => e.energy),
      protein: sum(all, e => e.protein),
      carbs: sum(all, e => e.carbs),
      fat: sum(all, e => e.fat),
      fibre: sum(all, e => e.fibre),
      sugar: sum(all, e => e.sugar),
    },
  };
}

/**
 * The calendar's list of days that carry records. The colour class is prefixed
 * differently depending on which of the two variants answered ("cc-good" from
 * the default route, "calendar-low" from the per-month one), so strip it.
 */
export function parseLoggedDays(raw: unknown): LoggedDay[] {
  if (!Array.isArray(raw)) throw new KtError('logged days: expected an array');
  return raw
    .map(entry => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map(entry => ({ date: czechDateFromEpoch(entry['date']), status: text(entry['colorClass']) }))
    .filter((day): day is { date: string; status: string | null } => day.date !== null)
    .map(day => ({ date: day.date, status: day.status?.replace(/^(cc|calendar)-/, '') ?? null }));
}

function parseNutrient(raw: unknown, fallbackTitle: string): NutrientAverage | null {
  const item = record(raw);
  if (!item) return null;
  return {
    title: text(item['title']) ?? fallbackTitle,
    perDay: parseCzechNumber(item['value']),
    target: parseCzechNumber(item['target']),
    percentOfTarget: parseCzechNumber(item['percent']),
  };
}

/**
 * Contributions arrive pre-rendered ("102 kcal", "7,3 g", "0,96 g"), because
 * that ranking is only ever drawn as text on the statistics page.
 */
function parseContribution(value: unknown): { perDay: number | null; unit: string | null } {
  const rendered = text(value);
  if (!rendered) return { perDay: null, unit: null };
  const match = /^([^a-zA-Z]+)\s*([a-zA-Z]+)?$/.exec(rendered.trim());
  if (!match) return { perDay: null, unit: null };
  return { perDay: parseCzechNumber(match[1] ?? ''), unit: match[2] ?? null };
}

function parseContributorGroups(raw: unknown): ContributorGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(group => record(group))
    .filter((group): group is Record<string, unknown> => group !== null && Array.isArray(group['items']))
    .map(group => ({
      nutrient: String(group['title'] ?? ''),
      items: (group['items'] as unknown[])
        .map(item => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map(item => ({
          title: String(item['title'] ?? ''),
          foodId: text(item['id']),
          ...parseContribution(item['valueString']),
          // "12x" — the count of diary entries over the range.
          timesLogged: parseCzechNumber(text(item['count'])?.replace(/x$/i, '') ?? null),
        })),
    }));
}

/** Days in an inclusive dd.MM.yyyy range; both ends are validated by the caller. */
function daysBetween(from: string, to: string): number {
  const asUtc = (date: string) => {
    const [d, m, y] = date.split('.').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.floor((asUtc(to) - asUtc(from)) / 86_400_000) + 1;
}

/**
 * The analysis route answers with per-day averages over the range — a range
 * where half the days have no records halves every number, which is what
 * `someDaysWithoutRecords` warns about.
 */
export function parsePeriodAnalysis(raw: unknown, from: string, to: string): PeriodAnalysis {
  const analysis = record(raw);
  if (!analysis || !Array.isArray(analysis['list'])) {
    throw new KtError(`analysis ${from}-${to}: expected nutrient averages`);
  }
  const energy = parseNutrient(analysis['energy'], 'Energie');
  if (!energy) throw new KtError(`analysis ${from}-${to}: no energy average`);

  return {
    from,
    to,
    days: daysBetween(from, to),
    someDaysWithoutRecords: analysis['recordsMissing'] === true,
    energy,
    energyUnit: text(record(analysis['energy'])?.['energyUnit']) ?? 'kcal',
    nutrients: analysis['list']
      .map(item => parseNutrient(item, ''))
      .filter((item): item is NutrientAverage => item !== null && item.title !== ''),
    salt: parseNutrient(analysis['salt'], 'Sůl'),
    drink: parseNutrient(analysis['drink'], 'Pitný režim'),
    topFoods: parseContributorGroups(analysis['totalValueInfluence']),
    topCategories: parseContributorGroups(analysis['totalValueInfluenceCategory']),
  };
}

export interface KtCredentials {
  email: string;
  password: string;
}

export class KtClient {
  private cookie: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly credentials: KtCredentials) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; redirectedToLogin: boolean; text: string }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json',
    };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });

    // Capture a rotated session cookie whenever the site issues one.
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const jsession = setCookie.find(c => c.startsWith('JSESSIONID='));
    if (jsession) this.cookie = jsession.split(';')[0] ?? null;

    // Spring Security answers unauthenticated /user/** with a 302 to /login.
    const location = response.headers.get('location') ?? '';
    const redirectedToLogin = response.status >= 300 && response.status < 400 && location.includes('/login');

    return { status: response.status, redirectedToLogin, text: await response.text() };
  }

  private parseEnvelope(text: string, context: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KtError(`${context}: expected JSON, got ${text.slice(0, 120)}`);
    }
    // Two envelope shapes exist: most routes send {code, message, data}, but
    // some list endpoints send {requestId, count, data} with no code at all.
    // Unwrap `data` whenever it is present, and only enforce `code` when it is.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const envelope = body as { code?: number; message?: string; data?: unknown };
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        throw new KtError(`${context}: ${envelope.message ?? `code ${envelope.code}`}`);
      }
      if ('data' in envelope && envelope.data !== null) return envelope.data;
    }
    return body;
  }

  /** Logs in, reusing an in-flight attempt so concurrent tool calls don't stampede. */
  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      this.cookie = null;
      const passwordHash = createHash('md5').update(this.credentials.password).digest('hex');
      const { text } = await this.request('/login/create?format=json', {
        method: 'POST',
        body: { email: this.credentials.email, password: passwordHash },
      });
      this.parseEnvelope(text, 'login');
      if (!this.cookie) throw new KtError('login succeeded but no session cookie was issued');
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Runs an authenticated call, logging in on first use and once on session expiry. */
  private async authed(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.cookie) await this.login();
    let result = await this.request(path, init);
    if (result.redirectedToLogin) {
      await this.login();
      result = await this.request(path, init);
      if (result.redirectedToLogin) throw new KtError(`${path}: still unauthenticated after re-login`);
    }
    return this.parseEnvelope(result.text, path);
  }

  /**
   * Full-text or EAN search. Works anonymously, so no login is forced here.
   * A 13-digit barcode resolves to the matching product.
   */
  async search(query: string, limit = 10): Promise<FoodHit[]> {
    const { text } = await this.request(
      `/autocomplete/foodstuff-activity-meal?format=json&query=${encodeURIComponent(query)}`,
    );
    const data = this.parseEnvelope(text, 'search');
    if (!Array.isArray(data)) throw new KtError('search: expected an array of results');

    return data
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>)['clazz'] === 'foodstuff')
      .slice(0, limit)
      .map(row => ({
        id: String(row['id']),
        title: String(row['title']),
        energyPer100: parseCzechNumber(row['value']),
        energyUnit: typeof row['energyUnit'] === 'string' ? row['energyUnit'] : 'kcal',
        baseUnit: typeof row['unit'] === 'string' ? row['unit'] : 'g',
        brand: typeof row['brandName'] === 'string' ? row['brandName'] : null,
      }));
  }

  /**
   * The site's own add-entry form for a food. This is the source of truth for
   * which portion units exist ("kus (55 g)"), so "3 eggs" maps onto the site's
   * model instead of us guessing gram weights.
   */
  async getFoodDetail(foodId: string): Promise<FoodDetail> {
    const { text } = await this.request(
      `/foodstuff/detail/form/${encodeURIComponent(foodId)}?format=json&default=true`,
    );
    const form = this.parseEnvelope(text, 'food detail') as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`food detail: unknown food id ${foodId}`);

    const rawUnits = Array.isArray(form['unitOptions']) ? form['unitOptions'] : [];
    const units: UnitOption[] = rawUnits
      .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
      .map(u => ({
        id: String(u['id']),
        title: String(u['title']),
        grams: parseCzechNumber(u['multiplier']) ?? 0,
      }));
    // The site echoes back whatever guid is requested, even for foods that do
    // not exist, so the guid check above no longer catches bad ids. A real
    // food always offers at least its base unit; an empty list means the id
    // is unknown.
    if (units.length === 0) throw new KtError(`food detail: unknown food id ${foodId}`);

    return {
      id: form['guid'],
      title: String(form['title'] ?? ''),
      units,
      defaultUnitId: typeof form['unitGuid'] === 'string' ? form['unitGuid'] : GRAM_UNIT,
      defaultAmount: parseCzechNumber(form['multiplier']) ?? 100,
    };
  }

  /** Nutrition for a given quantity, scaled server-side by the site itself. */
  async getNutrition(foodId: string, amount: number, unitId: string): Promise<Nutrition> {
    const { text } = await this.request(
      `/foodstuff/detail/${encodeURIComponent(foodId)}/${amount}/${encodeURIComponent(unitId)}?format=json`,
    );
    const data = this.parseEnvelope(text, 'nutrition') as Record<string, unknown>;
    const food = data['foodstuff'];
    if (!food || typeof food !== 'object') throw new KtError('nutrition: response had no foodstuff block');
    const f = food as Record<string, unknown>;

    return {
      title: String(f['title'] ?? ''),
      energy: parseCzechNumber(f['energy']),
      energyUnit: typeof data['energyUnit'] === 'string' ? data['energyUnit'] : 'kcal',
      protein: parseCzechNumber(f['protein']),
      carbs: parseCzechNumber(f['carbohydrate']),
      fat: parseCzechNumber(f['fat']),
      sugar: parseCzechNumber(f['sugar']),
      fibre: parseCzechNumber(f['fiber']),
      saturatedFat: parseCzechNumber(f['saturatedFattyAcid']),
      salt: parseCzechNumber(f['salt']),
    };
  }

  /**
   * Creates a diary entry. We fetch the site's own form first and override only
   * the four fields that describe this portion, so any field we don't know
   * about keeps whatever value the site considers correct.
   *
   * The trailing `&=` is the site's (empty) CSRF token pair — its own frontend
   * appends it the same way.
   */
  async logFood(args: {
    foodId: string;
    amount: number;
    unitId?: string;
    meal: MealId;
    date?: string;
  }): Promise<void> {
    // Fetch the form with a session established, exactly as the site's own
    // frontend does: it carries user-specific fields (favourite, preferred
    // unit) that we must post back unchanged.
    const form = (await this.authed(
      `/foodstuff/detail/form/${encodeURIComponent(args.foodId)}?format=json&default=true`,
    )) as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`log food: unknown food id ${args.foodId}`);

    // The site's own frontend posts the fetched form back whole, option
    // arrays included — deviate from that and the server may reject the write
    // ("Potravinu se nepodařilo zapsat do deníku").
    const payload: Record<string, unknown> = { ...form };
    payload['multiplier'] = args.amount;
    payload['unitGuid'] = args.unitId ?? form['unitGuid'] ?? GRAM_UNIT;
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);

    await this.authed('/user/foodstuff/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Raw daily summary. Shape is not fully documented, so it is passed through. */
  async getDaySummary(date?: string): Promise<unknown> {
    return this.authed(`/statistic/summary/${date === undefined ? todayCzech() : assertCzechDate(date)}/get?format=json`);
  }

  /** Everything logged on one day, meal by meal — the diary page's own data. */
  async getDayEntries(date?: string): Promise<DiaryDay> {
    const day = date === undefined ? todayCzech() : assertCzechDate(date);
    return parseDiaryDay(await this.authed(`/user/diary/${day}/get?format=json`), day);
  }

  /**
   * Which days carry records, over the site's own rolling window of roughly
   * the last month. There is a second route that takes a date
   * (`filled-out/<date>/`), but the server ignores it and answers for the
   * current month either way, so it buys nothing — older days are read by
   * date with getDayEntries, or averaged with getPeriodAnalysis.
   */
  async getLoggedDays(): Promise<LoggedDay[]> {
    return parseLoggedDays(await this.authed('/user/diary/filled-out?format=json'));
  }

  /** Per-day averages across a date range, in one request. */
  async getPeriodAnalysis(from: string, to: string): Promise<PeriodAnalysis> {
    const start = assertCzechDate(from);
    const end = assertCzechDate(to);
    return parsePeriodAnalysis(
      await this.authed(`/statistic/analysis/graph/${start}/${end}/get?format=json`),
      start,
      end,
    );
  }

  // ---------------------------------------------------------------------
  // Meals (the site's word for a saved recipe)
  // ---------------------------------------------------------------------

  /** The user's saved recipes. */
  async listMeals(): Promise<MealSummary[]> {
    const data = await this.authed('/user/settings/meal/list?format=json&limit=100');
    if (!Array.isArray(data)) throw new KtError('meal list: expected an array');
    return data
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map(m => ({
        id: String(m['guid']),
        title: String(m['title'] ?? ''),
        energy: parseCzechNumber(m['energy']),
        energyUnit: typeof m['energyUnit'] === 'string' ? m['energyUnit'] : 'kcal',
        portions: parseCzechNumber(m['portions']) ?? 1,
      }));
  }

  /**
   * Builds one ingredient entry for a recipe payload.
   *
   * The site expects each ingredient to carry its own full unit list, so we
   * fetch the food's form and copy it. `count` is a multiple of the chosen
   * unit, not a weight: 2 × "porce (250 ml)" is 500 ml. Defaulting to the
   * food's base unit (multiplier 1) makes `amount` mean grams for solids and
   * millilitres for liquids, which is what a recipe author expects.
   */
  private async buildMealItem(
    index: number,
    ingredient: { foodId: string; amount: number; unitId?: string },
  ): Promise<Record<string, unknown>> {
    const detail = await this.getFoodDetail(ingredient.foodId);
    const unitId = ingredient.unitId ?? baseUnitOf(detail.units);
    if (!detail.units.some(u => u.id === unitId)) {
      throw new KtError(
        `${detail.title}: unit ${unitId} is not valid for this food. Available: ` +
          detail.units.map(u => `${u.title} (${u.id})`).join(', '),
      );
    }
    return {
      selected: true,
      guid: String(index),
      foodstuffGuid: detail.id,
      title: detail.title,
      count: ingredient.amount,
      countOriginal: ingredient.amount,
      // Display-only; the site recomputes the recipe's energy server-side.
      energy: 0,
      energyUnit: 'kcal',
      selectedUnitGuid: unitId,
      selectedUnitGuidOriginal: unitId,
      units: detail.units.map(u => ({ id: u.id, title: u.title, multiplier: u.grams })),
      weight: null,
      time: null,
      favorite: null,
      isLiquid: null,
    };
  }

  /** Creates a saved recipe. Returns the new meal's id. */
  async createMeal(args: {
    title: string;
    ingredients: Array<{ foodId: string; amount: number; unitId?: string }>;
  }): Promise<string> {
    if (args.ingredients.length === 0) throw new KtError('a recipe needs at least one ingredient');

    const foodstuff = [];
    for (const [i, ingredient] of args.ingredients.entries()) {
      foodstuff.push(await this.buildMealItem(i, ingredient));
    }

    const created = await this.authed('/user/meal/create?format=json&=', {
      method: 'POST',
      body: {
        guid: null,
        title: args.title,
        diaryTimeGuid: null,
        diaryTimeOptions: null,
        date: null,
        timeUser: null,
        time: null,
        foodstuff,
      },
    });
    if (typeof created !== 'string') throw new KtError('meal create: no id returned');
    return created;
  }

  /**
   * Logs a whole saved recipe into the diary.
   *
   * Partial portions are deliberately not offered. The meal-add form exposes
   * `count` against portion/percent/gram pseudo-units, but the server ignores
   * it and logs the entire recipe whichever unit is used — measured against a
   * 249 kcal recipe, `count` of 0.5 portions and of half the total weight both
   * added the full 249. Rather than accept a `portions` argument that silently
   * does nothing, log the whole recipe and let the caller log ingredients
   * individually when they ate part of one.
   */
  async logMeal(args: { mealId: string; meal: MealId; date?: string }): Promise<void> {
    const form = (await this.authed(
      `/user/meal/add/form/${encodeURIComponent(args.mealId)}?format=json`,
    )) as Record<string, unknown>;

    // As in logFood: post the form back whole, as the site's frontend does.
    const payload: Record<string, unknown> = { ...form };
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);
    payload['selectedUnitGuid'] = PORTION_UNIT;
    payload['count'] = 1;

    await this.authed('/user/meal/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Permanently deletes a saved recipe. */
  async deleteMeal(mealId: string): Promise<void> {
    await this.authed(`/user/settings/meal/delete/${encodeURIComponent(mealId)}?format=json`);
  }
}
