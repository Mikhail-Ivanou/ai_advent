import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Forecast, HOURLY_STEP, MAX_DAYS, MAX_HOURLY_DAYS, WeatherError, geocode, getForecast } from './open-meteo.js';

const round = (n: number) => Math.round(n);
const signed = (n: number) => `${n > 0 ? '+' : ''}${round(n)}`;

/** Plain-text rendering for the model — compact, one line per row, units spelled out once. */
function formatForecast(f: Forecast, notes: string[]): string {
  const { location: loc, current: now, units } = f;
  const place = [loc.name, loc.region !== loc.name ? loc.region : undefined, loc.country].filter(Boolean).join(', ');
  const lines = [
    `Погода: ${place} (${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}, часовой пояс ${loc.timezone})`,
    `Сейчас (${now.time.replace('T', ' ')}): ${signed(now.temperature)}${units.temperature}, ощущается как ${signed(now.feelsLike)}${units.temperature}, ${now.conditions}, влажность ${now.humidity}%, ветер ${now.windDirection} ${now.windSpeed} ${units.windSpeed}`,
    '',
    `Прогноз по дням (${f.daily.length}):`,
    ...f.daily.map(
      (d) =>
        `${d.date}: ${signed(d.temperatureMin)}…${signed(d.temperatureMax)}${units.temperature}, ${d.conditions}, осадки ${d.precipitationSum} ${units.precipitation}` +
        (d.precipitationProbability !== null ? ` (вероятность ${d.precipitationProbability}%)` : '') +
        `, ветер до ${d.windSpeedMax} ${units.windSpeed}` +
        (d.uvIndexMax !== null ? `, УФ ${d.uvIndexMax}` : '') +
        `, восход ${d.sunrise.slice(11)}, закат ${d.sunset.slice(11)}`,
    ),
  ];
  if (f.hourly) {
    lines.push('', `Почасовой прогноз (каждые ${HOURLY_STEP} ч):`);
    lines.push(
      ...f.hourly.map(
        (h) =>
          `${h.time.replace('T', ' ')}: ${signed(h.temperature)}${units.temperature}, ${h.conditions}` +
          (h.precipitationProbability !== null ? `, осадки ${h.precipitationProbability}%` : '') +
          (h.precipitation > 0 ? ` (${h.precipitation} ${units.precipitation})` : '') +
          `, ветер ${h.windSpeed} ${units.windSpeed}`,
      ),
    );
  }
  if (notes.length) lines.push('', ...notes.map((n) => `Примечание: ${n}`));
  lines.push('', 'Источник: Open-Meteo.com');
  return lines.join('\n');
}

const locationSchema = z.object({
  name: z.string(),
  country: z.string().optional(),
  region: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
});

const outputSchema = {
  location: locationSchema,
  units: z.object({ temperature: z.string(), precipitation: z.string(), windSpeed: z.string() }),
  current: z.object({
    time: z.string(),
    temperature: z.number(),
    feelsLike: z.number(),
    humidity: z.number(),
    windSpeed: z.number(),
    windDirection: z.string(),
    conditions: z.string(),
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      conditions: z.string(),
      temperatureMin: z.number(),
      temperatureMax: z.number(),
      precipitationSum: z.number(),
      precipitationProbability: z.number().nullable(),
      windSpeedMax: z.number(),
      uvIndexMax: z.number().nullable(),
      sunrise: z.string(),
      sunset: z.string(),
    }),
  ),
  hourly: z
    .array(
      z.object({
        time: z.string(),
        conditions: z.string(),
        temperature: z.number(),
        precipitationProbability: z.number().nullable(),
        precipitation: z.number(),
        windSpeed: z.number(),
      }),
    )
    .optional(),
  notes: z.array(z.string()),
};

/** One server instance per request (the HTTP transport runs stateless), so this must stay cheap. */
export function createWeatherServer(): McpServer {
  const server = new McpServer({ name: 'advent-weather', version: '0.1.0' });

  server.registerTool(
    'get_weather_forecast',
    {
      title: 'Прогноз погоды',
      description:
        'Текущая погода и прогноз для города: температура, осадки, ветер, УФ-индекс, восход/закат. ' +
        'Используй, когда пользователь спрашивает о погоде, о том, что надеть, брать ли зонт, или планирует что-то на улице.',
      inputSchema: {
        city: z
          .string()
          .min(1)
          .describe(
            'Название города на любом языке, например «Минск» или «London». Если название неоднозначное, уточни страной через запятую: «Париж, Франция» или «Paris, US».',
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .default(3)
          .describe(`Сколько дней прогноза вернуть, начиная с сегодня (1–${MAX_DAYS}).`),
        detail: z
          .enum(['daily', 'hourly'])
          .default('daily')
          .describe(
            `Детализация: "daily" — сводка по дням; "hourly" — дополнительно почасовой прогноз с шагом ${HOURLY_STEP} ч (не больше ${MAX_HOURLY_DAYS} дней).`,
          ),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city, days, detail }) => {
      const notes: string[] = [];
      let effectiveDays = days;
      if (detail === 'hourly' && days > MAX_HOURLY_DAYS) {
        effectiveDays = MAX_HOURLY_DAYS;
        notes.push(`почасовой прогноз ограничен ${MAX_HOURLY_DAYS} днями — запрошено ${days}, возвращено ${MAX_HOURLY_DAYS}.`);
      }
      try {
        const location = await geocode(city);
        const forecast = await getForecast(location, effectiveDays, detail);
        return {
          content: [{ type: 'text', text: formatForecast(forecast, notes) }],
          structuredContent: { ...forecast, notes },
        };
      } catch (error) {
        // Tool-level errors go back as a result the model can read and react
        // to ("city not found — ask the user"), not as a protocol error.
        if (error instanceof WeatherError) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  return server;
}
