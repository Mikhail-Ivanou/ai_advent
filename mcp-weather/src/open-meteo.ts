// Thin client over Open-Meteo (https://open-meteo.com): free, no API key, so
// nothing secret has to ship with the server. Two calls per forecast — the
// geocoding API resolves a city name to coordinates, then the forecast API.

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// Overridable because some networks can't reach api.open-meteo.com's address
// (seen on h3llo.cloud); Open-Meteo's other hosts serve the same /v1/forecast
// from the same backend — see .env.example.
const FORECAST_URL = process.env.OPEN_METEO_FORECAST_URL?.trim() || 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 10_000;

/** Hourly rows are sampled every N hours — enough to see the shape of the day without flooding the model's context. */
export const HOURLY_STEP = 3;
/** Past this, an hourly forecast stops being useful to anyone and just burns context. */
export const MAX_HOURLY_DAYS = 7;
export const MAX_DAYS = 16;

export type Detail = 'daily' | 'hourly';

export interface Location {
  name: string;
  country?: string;
  region?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface CurrentWeather {
  time: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windDirection: string;
  conditions: string;
}

export interface DailyForecast {
  date: string;
  conditions: string;
  temperatureMin: number;
  temperatureMax: number;
  precipitationSum: number;
  precipitationProbability: number | null;
  windSpeedMax: number;
  uvIndexMax: number | null;
  sunrise: string;
  sunset: string;
}

export interface HourlyForecast {
  time: string;
  conditions: string;
  temperature: number;
  precipitationProbability: number | null;
  precipitation: number;
  windSpeed: number;
}

export interface Forecast {
  location: Location;
  units: { temperature: string; precipitation: string; windSpeed: string };
  current: CurrentWeather;
  daily: DailyForecast[];
  hourly?: HourlyForecast[];
}

export class WeatherError extends Error {}

// WMO weather interpretation codes, as returned in `weather_code`.
const WMO_CODES: Record<number, string> = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'туман с изморозью',
  51: 'слабая морось',
  53: 'морось',
  55: 'сильная морось',
  56: 'слабая ледяная морось',
  57: 'ледяная морось',
  61: 'небольшой дождь',
  63: 'дождь',
  65: 'сильный дождь',
  66: 'ледяной дождь',
  67: 'сильный ледяной дождь',
  71: 'небольшой снег',
  73: 'снег',
  75: 'сильный снег',
  77: 'снежные зёрна',
  80: 'небольшой ливень',
  81: 'ливень',
  82: 'сильный ливень',
  85: 'небольшой снегопад',
  86: 'сильный снегопад',
  95: 'гроза',
  96: 'гроза с небольшим градом',
  99: 'гроза с сильным градом',
};

function describeCode(code: number): string {
  return WMO_CODES[code] ?? `код погоды ${code}`;
}

const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

function compass(degrees: number): string {
  return COMPASS[Math.round(degrees / 45) % 8];
}

async function getJson(url: URL): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new WeatherError(`Сервис погоды недоступен: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new WeatherError(`Сервис погоды вернул ошибку ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

/**
 * Resolves "Минск" or "Paris, US" / "Париж, Франция" to coordinates. The part
 * after the comma narrows by country name or ISO code, since bare city names
 * are ambiguous (there are dozens of Parises).
 */
export async function geocode(query: string): Promise<Location> {
  const [name, qualifier] = query.split(',').map((part) => part.trim());
  if (!name) throw new WeatherError('Не указан город');

  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', qualifier ? '20' : '1');
  url.searchParams.set('language', 'ru');
  url.searchParams.set('format', 'json');
  const data = await getJson(url);

  const results: any[] = data.results ?? [];
  const q = qualifier?.toLowerCase();
  const match = q
    ? results.find((r) =>
        [r.country, r.country_code, r.admin1].some((field) => typeof field === 'string' && field.toLowerCase() === q),
      )
    : results[0];
  if (!match) {
    throw new WeatherError(
      qualifier ? `Город «${name}» в «${qualifier}» не найден` : `Город «${name}» не найден — проверьте написание`,
    );
  }
  return {
    name: match.name,
    country: match.country,
    region: match.admin1,
    latitude: match.latitude,
    longitude: match.longitude,
    timezone: match.timezone ?? 'auto',
  };
}

export async function getForecast(location: Location, days: number, detail: Detail): Promise<Forecast> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('timezone', location.timezone);
  url.searchParams.set('forecast_days', String(days));
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset',
  );
  if (detail === 'hourly') {
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m');
  }
  const data = await getJson(url);

  const c = data.current;
  const d = data.daily;
  const forecast: Forecast = {
    location,
    units: {
      temperature: data.current_units?.temperature_2m ?? '°C',
      precipitation: data.daily_units?.precipitation_sum ?? 'mm',
      windSpeed: data.current_units?.wind_speed_10m ?? 'm/s',
    },
    current: {
      time: c.time,
      temperature: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      windDirection: compass(c.wind_direction_10m),
      conditions: describeCode(c.weather_code),
    },
    daily: (d.time as string[]).map((date, i) => ({
      date,
      conditions: describeCode(d.weather_code[i]),
      temperatureMin: d.temperature_2m_min[i],
      temperatureMax: d.temperature_2m_max[i],
      precipitationSum: d.precipitation_sum[i],
      precipitationProbability: d.precipitation_probability_max[i] ?? null,
      windSpeedMax: d.wind_speed_10m_max[i],
      uvIndexMax: d.uv_index_max[i] ?? null,
      sunrise: d.sunrise[i],
      sunset: d.sunset[i],
    })),
  };

  if (detail === 'hourly') {
    const h = data.hourly;
    forecast.hourly = (h.time as string[])
      .map((time, i) => ({
        time,
        conditions: describeCode(h.weather_code[i]),
        temperature: h.temperature_2m[i],
        precipitationProbability: h.precipitation_probability[i] ?? null,
        precipitation: h.precipitation[i],
        windSpeed: h.wind_speed_10m[i],
      }))
      .filter((row) => Number(row.time.slice(11, 13)) % HOURLY_STEP === 0);
  }
  return forecast;
}
