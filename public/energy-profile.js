const https = require("https");
const { getStore } = require("@netlify/blobs");

function getSettingsStore() {
  return getStore({
    name: "energy-settings",
    siteID: process.env.SITE_ID || "97c929b2-ba49-4387-8b70-54f63763d686",
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
}

function octopusGet(path) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OCTOPUS_API_KEY;
    const credentials = Buffer.from(`${apiKey}:`).toString("base64");
    const options = {
      hostname: "api.octopus.energy",
      path,
      headers: { Authorization: `Basic ${credentials}` },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse: ${data}`)); }
      });
    }).on("error", reject);
  });
}

function getUKDateString(date) {
  return date.toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).split("/").reverse().join("-");
}

function ukMidnightToUTC(ukDateStr) {
  const [y, m, d] = ukDateStr.split("-").map(Number);
  const testDate = new Date(Date.UTC(y, m - 1, d));
  const ukOffset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", timeZoneName: "shortOffset",
  }).formatToParts(testDate).find(p => p.type === "timeZoneName")?.value || "GMT+0";
  const offsetMatch = ukOffset.match(/GMT([+-])(\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[2]) * (offsetMatch[1] === "+" ? -1 : 1) : 0;
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0)).toISOString().slice(0, 19) + "Z";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const store = getSettingsStore();
    const MPAN = process.env.MPAN;
    const ELEC_SERIAL = "Z17N039347";

    const now = new Date();
    const todayUK = getUKDateString(now);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = getUKDateString(thirtyDaysAgo);

    const fromUTC = ukMidnightToUTC(thirtyDaysAgoStr);
    const toUTC = ukMidnightToUTC(todayUK);

    const toUKTime = (isoStr) => new Date(isoStr).toLocaleTimeString("en-GB", {
      timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const raw = await octopusGet(
      `/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${fromUTC}&period_to=${toUTC}&page_size=1500&order_by=period`
    );

    const results = raw.results || [];

    // Build day totals and day-of-week profiles
    const dayTotals = {};
    const dowTotals = {};
    const dowCounts = {};
    const slotTotals = {};
    const slotCounts = {};

    results.forEach(r => {
      const date = new Date(r.interval_start).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
      const dow = new Date(r.interval_start).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long" });
      const time = toUKTime(r.interval_start);
      const kwh = r.consumption;

      if (!dayTotals[date]) dayTotals[date] = 0;
      dayTotals[date] += kwh;

      if (!dowTotals[dow]) { dowTotals[dow] = 0; dowCounts[dow] = 0; }
      dowTotals[dow] += kwh;
      dowCounts[dow]++;

      if (!slotTotals[time]) { slotTotals[time] = 0; slotCounts[time] = 0; }
      slotTotals[time] += kwh;
      slotCounts[time]++;
    });

    // Day of week averages
    const dowAvgs = {};
    Object.keys(dowTotals).forEach(dow => {
      const slotsPerDay = 48;
      dowAvgs[dow] = Math.round((dowTotals[dow] / (dowCounts[dow] / slotsPerDay)) * 10) / 10;
    });

    // Overall daily avg
    const dailyValues = Object.values(dayTotals).map(v => Math.round(v * 100) / 100);
    const overallAvg = dailyValues.length
      ? Math.round(dailyValues.reduce((s, v) => s + v, 0) / dailyValues.length * 10) / 10
      : 0;

    // Peak slots (top 5 by average)
    const slotAvgs = {};
    Object.keys(slotTotals).forEach(t => {
      slotAvgs[t] = slotTotals[t] / slotCounts[t];
    });
    const peakSlots = Object.entries(slotAvgs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([time, avg]) => `${time} (avg ${Math.round(avg * 1000) / 1000} kWh)`);

    // High and low days
    const sortedDays = Object.entries(dayTotals).sort((a, b) => b[1] - a[1]);
    const highDays = sortedDays.slice(0, 3).map(([d, v]) => `${d}: ${Math.round(v * 10) / 10} kWh`);
    const lowDays = sortedDays.slice(-3).map(([d, v]) => `${d}: ${Math.round(v * 10) / 10} kWh`);

    // Load existing settings for memory notes
    let settings = {};
    try { settings = await store.get("settings", { type: "json" }) || {}; } catch {}
    const memoryNotes = settings.memoryNotes || [];

    const profile = `HOUSEHOLD ENERGY PROFILE — generated ${todayUK}
Based on 30 days of half-hourly smart meter data.

DAILY AVERAGES BY DAY OF WEEK:
${Object.entries(dowAvgs).map(([d, v]) => `${d}: ${v} kWh`).join("\n")}

OVERALL DAILY AVERAGE: ${overallAvg} kWh

PEAK USAGE SLOTS (average across 30 days):
${peakSlots.join("\n")}

HIGHEST USAGE DAYS (last 30 days):
${highDays.join("\n")}

LOWEST USAGE DAYS (last 30 days):
${lowDays.join("\n")}

SAVED MEMORY NOTES (${memoryNotes.length} entries):
${memoryNotes.map(n => `[${n.date}] ${n.text}`).join("\n") || "None yet."}`;

    // Save profile to settings
    await store.setJSON("settings", { ...settings, householdProfile: profile, profileGeneratedAt: todayUK });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, profile }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};