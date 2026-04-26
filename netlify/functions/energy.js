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

function m3ToKwh(m3) {
  return m3 * 1.02264 * 39.2 / 3.6;
}

function getPeriodDates(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let days;
  if (period === "week") days = 7;
  else if (period === "month") days = 30;
  else if (period === "3months") days = 90;
  else if (period === "year") days = 365;
  else days = 30;

  const currentFrom = new Date(today);
  currentFrom.setDate(today.getDate() - days);

  const previousFrom = new Date(currentFrom);
  previousFrom.setDate(currentFrom.getDate() - days);

  return {
    currentFrom: currentFrom.toISOString().split("T")[0] + "T00:00:00Z",
    previousFrom: previousFrom.toISOString().split("T")[0] + "T00:00:00Z",
    previousTo: currentFrom.toISOString().split("T")[0] + "T00:00:00Z",
    days,
  };
}

async function fetchConsumption(type, reference, serial, from, to, pageSize = 200) {
  const toParam = to ? `&period_to=${to}` : "";
  const path = type === "electricity"
    ? `/v1/electricity-meter-points/${reference}/meters/${serial}/consumption/?period_from=${from}${toParam}&page_size=${pageSize}&group_by=day&order_by=period`
    : `/v1/gas-meter-points/${reference}/meters/${serial}/consumption/?period_from=${from}${toParam}&page_size=${pageSize}&group_by=day&order_by=period`;
  const data = await octopusGet(path);
  return data.results || [];
}

exports.handler = async function (event) {
  try {
    const period = event.queryStringParameters?.period || "month";
    const MPAN = process.env.MPAN;
    const ELEC_SERIAL = "Z17N039347";
    const ELEC_TARIFF = "E-1R-VAR-22-11-01-B";

    const { currentFrom, previousFrom, previousTo, days } = getPeriodDates(period);

    // Fetch rates + both periods in parallel
    const [elecRateData, currentData, previousData] = await Promise.all([
      octopusGet(`/v1/products/VAR-22-11-01/electricity-tariffs/${ELEC_TARIFF}/standard-unit-rates/`),
      fetchConsumption("electricity", MPAN, ELEC_SERIAL, currentFrom, null),
      fetchConsumption("electricity", MPAN, ELEC_SERIAL, previousFrom, previousTo),
    ]);

    const elecRate = elecRateData.results[0].value_inc_vat;

    const mapData = (results) => results.map((r) => ({
      date: r.interval_start.slice(0, 10),
      kwh: Math.round(r.consumption * 100) / 100,
      gbp: Math.round((r.consumption * elecRate / 100) * 100) / 100,
    }));

    const current = mapData(currentData);
    const previous = mapData(previousData);

    // Ofgem typical: 2700 kWh/year electricity
    const ofgemDailyKwh = 2700 / 365;
    const ofgemPeriodKwh = Math.round(ofgemDailyKwh * days * 10) / 10;
    const ofgemPeriodGbp = Math.round((ofgemPeriodKwh * elecRate / 100) * 100) / 100;

    const currentTotalKwh = Math.round(current.reduce((s, d) => s + d.kwh, 0) * 10) / 10;
    const currentTotalGbp = Math.round(current.reduce((s, d) => s + d.gbp, 0) * 100) / 100;
    const previousTotalKwh = Math.round(previous.reduce((s, d) => s + d.kwh, 0) * 10) / 10;
    const previousTotalGbp = Math.round(previous.reduce((s, d) => s + d.gbp, 0) * 100) / 100;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elecRate,
        period,
        days,
        current,
        previous,
        currentTotalKwh,
        currentTotalGbp,
        previousTotalKwh,
        previousTotalGbp,
        ofgemPeriodKwh,
        ofgemPeriodGbp,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};