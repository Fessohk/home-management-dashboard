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
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse: ${data}`)); }
      });
    }).on("error", reject);
  });
}

// Get UK local date string (handles GMT/BST automatically)
function getUKDateString(date) {
  return date.toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).split("/").reverse().join("-");
}

// Get midnight UK time as UTC ISO string for a given UK date string
function ukMidnightToUTC(ukDateStr) {
  // Parse as UK midnight
  const [y, m, d] = ukDateStr.split("-").map(Number);
  // Use Intl to find the UTC offset for that date in London
  const testDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const ukOffset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(testDate).find(p => p.type === "timeZoneName")?.value || "GMT+0";

  const offsetMatch = ukOffset.match(/GMT([+-])(\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[2]) * (offsetMatch[1] === "+" ? -1 : 1) : 0;

  const utc = new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0));
  return utc.toISOString().slice(0, 19) + "Z";
}

exports.handler = async function (event) {
  try {
    const MPAN = process.env.MPAN;
    const ELEC_SERIAL = "Z17N039347";
    const ELEC_TARIFF = "E-1R-VAR-22-11-01-B";

    const now = new Date();
    const todayUK = getUKDateString(now);

    // Accept optional date param
    const requestedDate = event.queryStringParameters?.date || null;
    const targetDateStr = requestedDate || todayUK;
    const isToday = targetDateStr === todayUK;

    // Get prev and 30-days-ago date strings
    const targetDateObj = new Date(targetDateStr + "T12:00:00Z");
    const prevDateObj = new Date(targetDateObj);
    prevDateObj.setDate(prevDateObj.getDate() - 1);
    const prevDateStr = prevDateObj.toISOString().slice(0, 10);

    const thirtyDaysAgoObj = new Date(targetDateObj);
    thirtyDaysAgoObj.setDate(thirtyDaysAgoObj.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgoObj.toISOString().slice(0, 10);

    const nextDateObj = new Date(targetDateObj);
    nextDateObj.setDate(nextDateObj.getDate() + 1);
    const nextDateStr = nextDateObj.toISOString().slice(0, 10);

    const targetFrom = ukMidnightToUTC(targetDateStr);
    const targetTo = ukMidnightToUTC(nextDateStr);
    const prevFrom = ukMidnightToUTC(prevDateStr);
    const prevTo = ukMidnightToUTC(targetDateStr);
    const historyFrom = ukMidnightToUTC(thirtyDaysAgoStr);
    const historyTo = ukMidnightToUTC(prevDateStr);

    const [targetRaw, prevRaw, historyRaw, rateRaw] = await Promise.all([
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${targetFrom}&period_to=${targetTo}&page_size=100&order_by=period`),
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${prevFrom}&period_to=${prevTo}&page_size=100&order_by=period`),
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${historyFrom}&period_to=${historyTo}&page_size=1500&order_by=period`),
      octopusGet(`/v1/products/VAR-22-11-01/electricity-tariffs/${ELEC_TARIFF}/standard-unit-rates/`),
    ]);

    const elecRate = rateRaw.results?.[0]?.value_inc_vat || null;

    // Convert interval_start to UK local time for slot keys
    const toUKTime = (isoStr) => {
      return new Date(isoStr).toLocaleTimeString("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    };

    const targetSlots = (targetRaw.results || []).map(r => ({
      time: toUKTime(r.interval_start),
      kwh: Math.round(r.consumption * 1000) / 1000,
    }));

    const prevSlots = (prevRaw.results || []).map(r => ({
      time: toUKTime(r.interval_start),
      kwh: Math.round(r.consumption * 1000) / 1000,
    }));

    // Build 30-day average profile by UK local time slot
    const slotTotals = {};
    const slotCounts = {};
    (historyRaw.results || []).forEach(r => {
      const time = toUKTime(r.interval_start);
      if (!slotTotals[time]) { slotTotals[time] = 0; slotCounts[time] = 0; }
      slotTotals[time] += r.consumption;
      slotCounts[time]++;
    });
    const avgProfile = {};
    Object.keys(slotTotals).forEach(t => {
      avgProfile[t] = Math.round((slotTotals[t] / slotCounts[t]) * 1000) / 1000;
    });

    const targetTotalKwh = Math.round(targetSlots.reduce((s, r) => s + r.kwh, 0) * 100) / 100;
    const prevTotalKwh = Math.round(prevSlots.reduce((s, r) => s + r.kwh, 0) * 100) / 100;
    const avgDayTotal = Math.round(Object.values(avgProfile).reduce((s, v) => s + v, 0) * 100) / 100;

    const latestTime = targetSlots.length ? targetSlots[targetSlots.length - 1].time : null;

    const avgToNow = Math.round(
      targetSlots.reduce((s, slot) => s + (avgProfile[slot.time] || 0), 0) * 100
    ) / 100;

    // Run-rate estimate
    const estimate = avgToNow > 0 && targetTotalKwh > 0
      ? Math.round((targetTotalKwh * (avgDayTotal / avgToNow)) * 100) / 100
      : null;

    const estimateGbp = estimate && elecRate
      ? Math.round(estimate * elecRate / 100 * 100) / 100
      : null;

    const targetGbp = elecRate
      ? Math.round(targetTotalKwh * elecRate / 100 * 100) / 100
      : null;

    const prevGbp = elecRate
      ? Math.round(prevTotalKwh * elecRate / 100 * 100) / 100
      : null;

    const avgGbp = elecRate
      ? Math.round(avgDayTotal * elecRate / 100 * 100) / 100
      : null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: targetDateStr,
        isToday,
        elecRate,
        target: {
          slots: targetSlots,
          totalKwh: targetTotalKwh,
          totalGbp: targetGbp,
          latestTime,
          avgToNow,
          estimate,
          estimateGbp,
        },
        prev: {
          slots: prevSlots,
          totalKwh: prevTotalKwh,
          totalGbp: prevGbp,
          avgDayTotal,
          avgGbp,
        },
        avgProfile,
        avgDayTotal,
        avgGbp,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};