/**
 * The tool surface Claude sees.
 *
 * Designed around one flow: "I ate 3 eggs" → search → pick a portion unit →
 * log. Descriptions are prescriptive about *when* to call each tool, because
 * that is what drives correct tool selection.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { baseUnitOf, KtClient, MEALS, type MealId, todayCzech } from '../kt/client.js';

const MEAL_IDS = Object.keys(MEALS) as [MealId, ...MealId[]];

const mealDescription = `Which meal slot to file the entry under: ${Object.entries(MEALS)
  .map(([id, name]) => `${id} = ${name}`)
  .join(', ')}.`;

// Omitting unit_id means the food's base unit, which is not always grams:
// drinks count in millilitres and have no gram unit at all.
const amountDescription =
  'How many units. Without unit_id this is grams for food and millilitres for drinks — the food\'s base unit.';
const unitDescription =
  'Unit id from get_food_portions. Omit to use the food\'s base unit (grams for food, millilitres for drinks).';

const dateDescription =
  'Date in dd.MM.yyyy format (Czech style). Omit for today. Use this to log something the user ate on a previous day.';

/** Tool results are text; JSON keeps them unambiguous for the model. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so every call lands in the container log with its
 * arguments and outcome, and every throw becomes an in-band tool error.
 * Without this, a failing tool is invisible from the server side.
 */
function guard<Args>(name: string, fn: (args: Args) => Promise<ReturnType<typeof json>>) {
  return async (args: Args) => {
    try {
      const result = await fn(args);
      console.log(`[tool] ${name} ${JSON.stringify(args)} -> ok`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool] ${name} ${JSON.stringify(args)} -> ${message}`);
      return failure(error);
    }
  };
}

export function registerTools(server: McpServer, kt: KtClient): void {
  server.registerTool(
    'search_food',
    {
      title: 'Search foods',
      description:
        'Find foods in the kaloricketabulky.cz database by name or barcode. Call this first whenever the user mentions eating something, to get the food id the other tools need. ' +
        'The database is Czech, so prefer Czech search terms ("vejce" rather than "egg") for the best matches. ' +
        'A 13-digit EAN barcode also works and resolves to the exact product. ' +
        'Drinks live in the same database — "voda", "káva s mlékem", "pivo" — and are logged the same way.',
      inputSchema: {
        query: z.string().min(1).describe('Food name (Czech works best) or a 13-digit EAN barcode.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results to return. Defaults to 10.'),
      },
    },
    guard('search_food', async ({ query, limit }) => {
      const hits = await kt.search(query, limit ?? 10);
      if (hits.length === 0) {
        return json({ results: [], hint: 'No matches. Try a different or more general Czech term.' });
      }
      return json({ results: hits });
    }),
  );

  server.registerTool(
    'get_food_portions',
    {
      title: 'Get portion units for a food',
      description:
        'List the portion units a food supports (for example "kus (55 g)", "velký kus (60 g)") along with its default portion. ' +
        'Call this after search_food when the user gave a count rather than a weight ("3 eggs", "2 slices"), so you can log natural portions instead of guessing grams.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
      },
    },
    guard('get_food_portions', async ({ food_id }) => {
      const detail = await kt.getFoodDetail(food_id);
      return json({
        id: detail.id,
        title: detail.title,
        default: { amount: detail.defaultAmount, unit_id: detail.defaultUnitId },
        units: detail.units,
        base_unit_id: baseUnitOf(detail.units),
        note: 'Omit unit_id when logging to use base_unit_id: an amount in grams for food, in millilitres for drinks.',
      });
    }),
  );

  server.registerTool(
    'get_food_nutrition',
    {
      title: 'Get nutrition for a quantity',
      description:
        'Calculate calories and macros for a specific quantity of a food, without logging anything. ' +
        'Use this when the user asks what something contains, or to confirm a portion before logging it. The site does the scaling, so the numbers match its own diary exactly.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe(amountDescription),
        unit_id: z.string().optional().describe(unitDescription),
      },
    },
    guard('get_food_nutrition', async ({ food_id, amount, unit_id }) => {
      const unit = unit_id ?? baseUnitOf((await kt.getFoodDetail(food_id)).units);
      return json(await kt.getNutrition(food_id, amount, unit));
    }),
  );

  server.registerTool(
    'log_food',
    {
      title: 'Log food to the diary',
      description:
        'Write an eating record into the user\'s kaloricketabulky.cz diary. This modifies their real diary, so confirm the food and portion first if there was any ambiguity in what they said. ' +
        'Drinks go through here too: water, coffee or juice logged this way counts toward the day\'s drinking target (pitný režim), so "I drank half a litre of water" is search_food("voda") then log_food with amount 500. ' +
        'Returns the nutrition that was logged.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe(amountDescription),
        unit_id: z.string().optional().describe(unitDescription),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_food', async ({ food_id, amount, unit_id, meal, date }) => {
      const { unitId: unit } = await kt.logFood({ foodId: food_id, amount, unitId: unit_id, meal, date });
      // The write has landed; a failed read-back must not become a tool error,
      // or the model retries and logs the food twice.
      const nutrition = await kt.getNutrition(food_id, amount, unit).catch(() => null);
      return json({
        logged: true,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
        amount,
        nutrition,
      });
    }),
  );

  server.registerTool(
    'create_meal',
    {
      title: 'Create a saved recipe',
      description:
        'Save a recipe (the site calls it a "meal") built from existing foods, so it can be logged later in one step instead of ingredient by ingredient. ' +
        'Use this when the user describes something they cook regularly — a smoothie, a bread, a standard breakfast. ' +
        'Look each ingredient up with search_food first to get its id. ' +
        'IMPORTANT: `amount` counts units, not grams. Omit `unit_id` and `amount` means grams for solids and millilitres for liquids, which is what recipes are normally written in. ' +
        'If you do pass a unit_id from get_food_portions, then 2 with "porce (250 ml)" means 500 ml, not 2 ml.',
      inputSchema: {
        title: z.string().min(1).describe('Name for the recipe, e.g. "Ranní smoothie".'),
        ingredients: z
          .array(
            z.object({
              food_id: z.string().min(1).describe('Food id from search_food.'),
              amount: z.number().positive().describe('Number of units. With no unit_id this is grams or millilitres.'),
              unit_id: z
                .string()
                .optional()
                .describe('Optional unit id from get_food_portions. Omit for grams/millilitres.'),
            }),
          )
          .min(1)
          .describe('The ingredients, each with a quantity.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('create_meal', async ({ title, ingredients }) => {
      const id = await kt.createMeal({
        title,
        ingredients: ingredients.map(i => ({ foodId: i.food_id, amount: i.amount, unitId: i.unit_id })),
      });
      // The recipe exists now; the read-back is best-effort decoration only.
      const created = (await kt.listMeals().catch(() => [])).find(m => m.id === id);
      return json({
        created: true,
        meal_id: id,
        title,
        total_energy: created && created.energy !== null ? `${created.energy} ${created.energyUnit}` : null,
        note: 'Energy is for the whole recipe. Log it with log_meal.',
      });
    }),
  );

  server.registerTool(
    'list_my_meals',
    {
      title: 'List saved recipes',
      description:
        "List the user's own saved recipes with their ids and total energy. Call this before log_meal to find the right recipe id, or when the user asks what recipes they have saved.",
      inputSchema: {},
    },
    guard('list_my_meals', async () => {
      return json({ meals: await kt.listMeals() });
    }),
  );

  server.registerTool(
    'log_meal',
    {
      title: 'Log a saved recipe to the diary',
      description:
        "Log one of the user's saved recipes into their diary as a single entry. Find the recipe id with list_my_meals first. This writes to their real diary. " +
        'The whole recipe is always logged — the site provides no way to log a fraction of one. If the user ate only part of a recipe, log the individual ingredients with log_food instead.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_meal', async ({ meal_id, meal, date }) => {
      await kt.logMeal({ mealId: meal_id, meal, date });
      // Same as log_food: the diary entry exists, so the read-back may not fail the tool.
      const logged = (await kt.listMeals().catch(() => [])).find(m => m.id === meal_id);
      return json({
        logged: true,
        recipe: logged?.title ?? meal_id,
        energy: logged && logged.energy !== null ? `${logged.energy} ${logged.energyUnit}` : null,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
      });
    }),
  );

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a saved recipe',
      description:
        'Permanently delete one of the user\'s saved recipes. This cannot be undone, so confirm which recipe they mean before calling it. ' +
        'It removes the recipe only — diary entries already logged from it are untouched.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_meal', async ({ meal_id }) => {
      const before = (await kt.listMeals()).find(m => m.id === meal_id);
      if (!before) return json({ deleted: false, reason: 'No saved recipe with that id.' });
      await kt.deleteMeal(meal_id);
      return json({ deleted: true, title: before.title });
    }),
  );

  server.registerTool(
    'get_day_summary',
    {
      title: 'Get a day summary',
      description:
        'Read back totals from the diary for one day — use this when the user asks how many calories they have left or how a day went. ' +
        'It answers with totals and targets only; call get_day_entries when they ask what they actually ate.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
    },
    guard('get_day_summary', async ({ date }) => {
      return json({ date: date ?? todayCzech(), summary: await kt.getDaySummary(date) });
    }),
  );

  server.registerTool(
    'get_day_entries',
    {
      title: 'List a day\'s diary entries',
      description:
        'List everything logged on one day, meal by meal, with the portion and the energy and macros each entry contributed. ' +
        'Use this when the user asks what they ate, wants a day checked for a mistake, or refers to something they logged earlier. ' +
        'Each entry carries an entryId identifying that diary row, and a foodId usable with get_food_portions or log_food to repeat it.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('get_day_entries', async ({ date }) => {
      const day = await kt.getDayEntries(date);
      // Empty meal slots exist for every day; sending six of them back as
      // noise makes the interesting ones harder to see.
      return json({
        ...day,
        meals: day.meals.filter(meal => meal.entries.length > 0),
        note: 'totals are summed from the entries; get_day_summary has the site\'s own totals and the daily targets',
      });
    }),
  );

  server.registerTool(
    'get_logged_days',
    {
      title: 'List days with diary records',
      description:
        'List which days actually have records in the diary, with the site\'s own colour rating for each. ' +
        'Use it to find the days worth reading, or when the user asks how consistently they have been logging. ' +
        'It covers the site\'s own window of roughly the last month; further back, read a specific date with get_day_entries or average a range with get_period_analysis.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('get_logged_days', async () => {
      const days = await kt.getLoggedDays();
      return json({
        days,
        count: days.length,
        window: 'the site answers for roughly the last month; older dates still read fine with get_day_entries',
      });
    }),
  );

  server.registerTool(
    'get_period_analysis',
    {
      title: 'Average a period',
      description:
        'Averages over a date range in one request: energy, protein, carbohydrate, fat and fibre per day against their targets. ' +
        'It also answers "where is this coming from": per nutrient, the individual foods that contributed most of it, how much each added per day and how many times it was logged. ' +
        'Use this for "how did last week go", "am I getting enough protein" or "what is eating my calorie budget" instead of reading day after day. ' +
        'Every number is a per-day average over the whole range, including days with no records — when someDaysWithoutRecords is true the averages are pulled down by empty days.',
      inputSchema: {
        from: z.string().describe('First day of the range, dd.MM.yyyy.'),
        to: z.string().describe('Last day of the range, dd.MM.yyyy. Same as `from` for a single day.'),
        top: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('How many top foods to return per nutrient. Defaults to 5; 0 leaves them out entirely.'),
        by_category: z
          .boolean()
          .optional()
          .describe(
            'Also roll the ranking up into the site\'s food categories ("Fast food", "Maso drůbeží"). Off by default.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('get_period_analysis', async ({ from, to, top, by_category }) => {
      const analysis = await kt.getPeriodAnalysis(from, to);
      // The site sends ten foods for each of seven nutrients; handing all
      // seventy to the model buries the answer it was asked for.
      const limit = top ?? 5;
      const trim = (groups: typeof analysis.topFoods) =>
        limit === 0 ? [] : groups.map(g => ({ ...g, items: g.items.slice(0, limit) }));
      return json({
        ...analysis,
        topFoods: trim(analysis.topFoods),
        topCategories: by_category === true ? trim(analysis.topCategories) : [],
      });
    }),
  );

  server.registerTool(
    'log_weight',
    {
      title: 'Log body weight',
      description:
        "Record body weight in kilograms in the user's real Kaloricke Tabulky weight history. " +
        'Call this only when the user explicitly asks to record or log a weight; never treat merely mentioning a weight as permission to write it. ' +
        'The tool returns only after Kaloricke Tabulky accepts the write.',
      inputSchema: {
        weight_kg: z
          .number()
          .min(20)
          .max(500)
          .describe('Body weight in kilograms, for example 103.3.'),
        date: z
          .string()
          .optional()
          .describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_weight', async ({ weight_kg, date }) => {
      await kt.logWeight({ weightKg: weight_kg, date });
      return json({
        logged: true,
        weight_kg,
        date: date ?? todayCzech(),
      });
    }),
  );
}
