/*
 * weather.js — Open-Meteo client. Same data source Corsair's own Weather widget uses.
 *
 * Both endpoints return `Access-Control-Allow-Origin: *`, so these are fetched directly;
 * only the Google Calendar feeds need the local proxy.
 *
 *   Weather.resolveLocation(query, language) -> Promise<location|null>
 *   Weather.fetchForecast(location, options) -> Promise<forecast>
 *   Weather.icon(weatherCode, isDay)         -> svg symbol id
 *   Weather.conditionKey(weatherCode)        -> translation key
 */
(function (root) {
  "use strict";

  var GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
  var FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  var TIMEOUT_MS = 12000;

  function request(url) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("timed out")); }
      }, TIMEOUT_MS);

      function done(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      fetch(url, { cache: "no-store" }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (data) {
        done(resolve, data);
      }).catch(function (error) {
        done(reject, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  function label(result) {
    var parts = [result.name];
    // Disambiguate the many same-named US cities the way Corsair's widget does.
    if (result.admin1 && result.country_code === "US") parts.push(result.admin1);
    else if (result.country) parts.push(result.country);
    return parts.join(", ");
  }

  /** Accepts a place name, or bare "lat,lon" for when geocoding picks the wrong city. */
  function resolveLocation(query, language) {
    var text = String(query || "").trim();
    if (!text) return Promise.resolve(null);

    var coords = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coords) {
      var lat = Number(coords[1]);
      var lon = Number(coords[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return Promise.resolve(null);
      return Promise.resolve({
        name: lat.toFixed(2) + ", " + lon.toFixed(2),
        latitude: lat, longitude: lon, timezone: null
      });
    }

    var url = GEOCODE_URL + "?name=" + encodeURIComponent(text) +
      "&count=1&language=" + encodeURIComponent(language || "en");

    return request(url).then(function (data) {
      var result = data && Array.isArray(data.results) ? data.results[0] : null;
      if (!result) return null;
      return {
        name: label(result),
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone || null
      };
    });
  }

  function fetchForecast(location, options) {
    options = options || {};
    var query = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day",
      daily: "temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_probability_max",
      timezone: "auto",
      forecast_days: String(Math.max(2, Math.min(7, options.days || 4))),
      temperature_unit: options.temperatureUnit === "°C" ? "celsius" : "fahrenheit",
      wind_speed_unit: options.windSpeedUnit === "km/h" ? "kmh" : "mph"
    });

    return request(FORECAST_URL + "?" + query.toString()).then(function (data) {
      var current = data.current || {};
      var daily = data.daily || {};
      var days = [];

      var times = daily.time || [];
      for (var i = 0; i < times.length; i++) {
        days.push({
          date: times[i],
          weatherCode: daily.weather_code ? daily.weather_code[i] : null,
          min: daily.temperature_2m_min ? daily.temperature_2m_min[i] : null,
          max: daily.temperature_2m_max ? daily.temperature_2m_max[i] : null,
          precipitationChance: daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null,
          sunrise: daily.sunrise ? daily.sunrise[i] : null,
          sunset: daily.sunset ? daily.sunset[i] : null
        });
      }

      return {
        locationName: location.name,
        timezone: data.timezone || null,
        temperature: current.temperature_2m,
        apparentTemperature: current.apparent_temperature,
        weatherCode: current.weather_code,
        windSpeed: current.wind_speed_10m,
        humidity: current.relative_humidity_2m,
        isDay: current.is_day !== 0,
        temperatureUnit: (data.current_units && data.current_units.temperature_2m) || "°",
        windSpeedUnit: (data.current_units && data.current_units.wind_speed_10m) || "",
        days: days
      };
    });
  }

  /* WMO weather codes -> the svg symbols defined in index.html. */
  function icon(weatherCode, isDay) {
    var code = Number(weatherCode);
    if (!Number.isFinite(code)) return "icon-cloudy";
    if (code === 0) return isDay ? "icon-clear-day" : "icon-clear-night";
    if (code === 1 || code === 2) return isDay ? "icon-partly-day" : "icon-partly-night";
    if (code === 3) return "icon-cloudy";
    if (code === 45 || code === 48) return "icon-fog";
    if (code >= 51 && code <= 57) return "icon-drizzle";
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "icon-rain";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "icon-snow";
    if (code >= 95 && code <= 99) return "icon-thunderstorm";
    return "icon-cloudy";
  }

  var CONDITIONS = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Heavy showers",
    85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm"
  };

  function conditionKey(weatherCode) {
    return CONDITIONS[Number(weatherCode)] || "Unknown";
  }

  root.Weather = {
    resolveLocation: resolveLocation,
    fetchForecast: fetchForecast,
    icon: icon,
    conditionKey: conditionKey
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
