const https = require("https");

function octopusGet(path) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OCTOPUS_API_KEY;
    const credentials = Buffer.from(`${apiKey}:`).toString("base64");
    const options = {
      hostname: "api.octopus.energy",
      path: path,
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
  const testDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const ukOffset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(testDate).find(p => p.type === "timeZoneName")?.value || "GMT+0";
  const offsetMatch = ukOffset.match(/GMT([+-])(\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[2]) * (offsetMatch[1] === "+" ? -1 : 1) : 0;
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0)).toISOString().slice(0, 19) + "Z";
}

exports.handler = async function (event) {
  try {
    const MPAN = process.env.MPAN;
    const ELEC_SERIAL = "Z17N039347";
    const ELEC_TARIFF = "E-1R-VAR-22-11-01-B";

    const now = new Date();
    const todayUK = getUKDateString(now);
    const requestedDate = event.queryStringParameters?.date || null;
    const targetDateStr = requestedDate || todayUK;
    const isToday = targetDateStr === todayUK;

    const targetDateObj = new Date(targetDateStr + "T12:00:00Z");
    const prevDateStr = new Date(targetDateObj.getTime() - 86400000).toISOString().slice(0, 10);
    const nextDateStr = new Date(targetDateObj.getTime() + 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgoStr = new Date(targetDateObj.getTime() - 30 * 86400000).toISOString().slice(0, 10);

    const targetFrom = ukMidnightToUTC(targetDateStr);
    const targetTo = ukMidnightToUTC(nextDateStr);
    const prevFrom = ukMidnightToUTC(prevDateStr);
    const prevTo = ukMidnightToUTC(targetDateStr);
    const historyFrom = ukMidnightToUTC(thirtyDaysAgoStr);
    const historyTo = ukMidnightToUTC(prevDateStr);

    const toUKTime = (isoStr) => new Date(isoStr).toLocaleTimeString("en-GB", {
      timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const [targetRaw, prevRaw, historyRaw, rateRaw] = await Promise.all([
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${targetFrom}&period_to=${targetTo}&page_size=100&order_by=period`),
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${prevFrom}&period_to=${prevTo}&page_size=100&order_by=period`),
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${historyFrom}&period_to=${historyTo}&page_size=1500&order_by=period`),
      octopusGet(`/v1/products/VAR-22-11-01/electricity-tariffs/${ELEC_TARIFF}/standard-unit-rates/`),
    ]);

    const elecRate = rateRaw.results?.[0]?.value_inc_vat || null;

    const rawTargetSlots = (targetRaw.results || []).map(r => ({
      time: toUKTime(r.interval_start),
      kwh: Math.round(r.consumption * 1000) / 1000,
    }));

    // Remove duplicate midnight (BST rollover)
    const cleanedSlots = rawTargetSlots.filter((slot, i) => {
      if (slot.time === "00:00" && i > 0) return false;
      return true;
    });

    // Only show if we have data up to at least 10:00
    const hasMinimumData = cleanedSlots.some(s => s.time >= "10:00");
    const validSlots = hasMinimumData ? cleanedSlots : [];

    const prevSlots = (prevRaw.results || []).map(r => ({
      time: toUKTime(r.interval_start),
      kwh: Math.round(r.consumption * 1000) / 1000,
    })).filter((slot, i, arr) => {
      if (slot.time === "00:00" && i > 0) return false;
      return true;
    });

    // Build 30-day average profile by half-hour slot
    const slotTotals = {};
    const slotCounts = {};
    const dowSlotTotals = {}; // day-of-week profiles
    const dowSlotCounts = {};

    (historyRaw.results || []).forEach(r => {
      const time = toUKTime(r.interval_start);
      const dow = new Date(r.interval_start).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long" });

      if (!slotTotals[time]) { slotTotals[time] = 0; slotCounts[time] = 0; }
      slotTotals[time] += r.consumption;
      slotCounts[time]++;

      if (!dowSlotTotals[dow]) { dowSlotTotals[dow] = {}; dowSlotCounts[dow] = {}; }
      if (!dowSlotTotals[dow][time]) { dowSlotTotals[dow][time] = 0; dowSlotCounts[dow][time] = 0; }
      dowSlotTotals[dow][time] += r.consumption;
      dowSlotCounts[dow][time]++;
    });

    const avgProfile = {};
    Object.keys(slotTotals).forEach(t => {
      avgProfile[t] = Math.round((slotTotals[t] / slotCounts[t]) * 1000) / 1000;
    });

    const dayOfWeekProfiles = {};
    Object.keys(dowSlotTotals).forEach(dow => {
      dayOfWeekProfiles[dow] = {};
      Object.keys(dowSlotTotals[dow]).forEach(t => {
        dayOfWeekProfiles[dow][t] = Math.round((dowSlotTotals[dow][t] / dowSlotCounts[dow][t]) * 1000) / 1000;
      });
    });

    const targetTotalKwh = Math.round(validSlots.reduce((s, r) => s + r.kwh, 0) * 100) / 100;
    const prevTotalKwh = Math.round(prevSlots.reduce((s, r) => s + r.kwh, 0) * 100) / 100;
    const avgDayTotal = Math.round(Object.values(avgProfile).reduce((s, v) => s + v, 0) * 100) / 100;
    const latestTime = validSlots.length ? validSlots[validSlots.length - 1].time : null;

    const avgToNow = Math.round(validSlots.reduce((s, slot) => s + (avgProfile[slot.time] || 0), 0) * 100) / 100;
    const estimate = avgToNow > 0 && targetTotalKwh > 0
      ? Math.round((targetTotalKwh * (avgDayTotal / avgToNow)) * 100) / 100
      : null;

    const toGbp = (kwh) => elecRate ? Math.round(kwh * elecRate / 100 * 100) / 100 : null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: targetDateStr,
        isToday,
        elecRate,
        target: {
          slots: validSlots,
          totalKwh: targetTotalKwh,
          totalGbp: toGbp(targetTotalKwh),
          latestTime,
          avgToNow,
          estimate,
          estimateGbp: toGbp(estimate),
        },
        prev: {
          slots: prevSlots,
          totalKwh: prevTotalKwh,
          totalGbp: toGbp(prevTotalKwh),
          avgDayTotal,
          avgGbp: toGbp(avgDayTotal),
        },
        avgProfile,
        dayOfWeekProfiles,
        avgDayTotal,
        avgGbp: toGbp(avgDayTotal),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};