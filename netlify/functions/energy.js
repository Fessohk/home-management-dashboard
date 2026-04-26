const https = require("https");

// Helper to make an authenticated request to the Octopus API
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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

function m3ToKwh(m3) {
  return m3 * 1.02264 * 39.2 / 3.6;
}

exports.handler = async function () {
  try {
    const MPAN = process.env.MPAN;
    const MPRN = process.env.MPRN;
    const ELEC_SERIAL = "Z17N039347";
    const GAS_SERIAL = "E6S11202861760";
    const ELEC_TARIFF = "E-1R-VAR-22-11-01-B";
    const GAS_TARIFF = "G-1R-VAR-22-11-01-B";

    const periodFrom = new Date();
    periodFrom.setDate(periodFrom.getDate() - 30);
    const from = periodFrom.toISOString().split("T")[0] + "T00:00:00Z";

    // Fetch everything in parallel
    const [elecRateData, gasRateData, elecData, gasData] = await Promise.all([
      octopusGet(`/v1/products/VAR-22-11-01/electricity-tariffs/${ELEC_TARIFF}/standard-unit-rates/`),
      octopusGet(`/v1/products/VAR-22-11-01/gas-tariffs/${GAS_TARIFF}/standard-unit-rates/`),
      octopusGet(`/v1/electricity-meter-points/${MPAN}/meters/${ELEC_SERIAL}/consumption/?period_from=${from}&page_size=100&group_by=day&order_by=period`),
      octopusGet(`/v1/gas-meter-points/${MPRN}/meters/${GAS_SERIAL}/consumption/?period_from=${from}&page_size=100&group_by=day&order_by=period`),
    ]);

    const elecRate = elecRateData.results[0].value_inc_vat;
    const gasRate = gasRateData.results[0].value_inc_vat;

    const electricity = elecData.results.map((r) => ({
      date: r.interval_start.slice(0, 10),
      kwh: Math.round(r.consumption * 100) / 100,
      gbp: Math.round((r.consumption * elecRate / 100) * 100) / 100,
    }));

    const gas = gasData.results.map((r) => {
      const kwh = m3ToKwh(r.consumption);
      return {
        date: r.interval_start.slice(0, 10),
        kwh: Math.round(kwh * 100) / 100,
        gbp: Math.round((kwh * gasRate / 100) * 100) / 100,
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elecRate,
        gasRate,
        electricity,
        gas,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};