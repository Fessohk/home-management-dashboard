const https = require("https");

function anthropicPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse: ${data}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function formatCostGBP(usd) {
  // Approximate USD to GBP at 0.79
  const gbp = usd * 0.79;
  if (gbp < 0.01) return "less than £0.01";
  return `£${gbp.toFixed(2)}`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const { date, slots, avgProfile, dayOfWeekProfiles, tags, memory, question, elecRate } = JSON.parse(event.body);

    const dayName = new Date(date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });
    const totalKwh = slots.reduce((s, r) => s + r.kwh, 0).toFixed(2);
    const totalGbp = elecRate ? (totalKwh * elecRate / 100).toFixed(2) : "unknown";

    const dowContext = Object.entries(dayOfWeekProfiles || {}).map(([day, profile]) => {
      const dayTotal = Object.values(profile).reduce((s, v) => s + v, 0).toFixed(1);
      return `${day}: avg ${dayTotal} kWh`;
    }).join(", ");

    const peak = slots.length ? slots.reduce((max, s) => s.kwh > max.kwh ? s : max, { time: "unknown", kwh: 0 }) : { time: "unknown", kwh: 0 };

    const systemPrompt = `You are an energy analyst for a UK household. Analyse their electricity usage and provide 2-3 sentences of specific, useful insight. Always include actual numbers (kWh, £, percentages). Reference day-of-week patterns where relevant. Be direct and conversational.

Household context (what the user has told you about their home and habits):
${memory || "No household context provided yet — encourage the user to add context below the analysis."}

Day-of-week averages from last 30 days: ${dowContext || "Not yet available."}

Tags for this day: ${tags && tags.length ? tags.join(", ") : "None"}

Date: ${dayName}, ${date}
Total usage so far: ${totalKwh} kWh (£${totalGbp})
Peak half-hour: ${peak.time} at ${peak.kwh} kWh
Electricity rate: ${elecRate ? elecRate.toFixed(2) : "24.99"}p/kWh

Half-hourly data:
${slots.map(s => `${s.time}: ${s.kwh} kWh`).join("\n")}`;

    const userMessage = question && question.trim()
      ? question.trim()
      : "Analyse this day's energy usage. Flag anything unusual, reference typical patterns for this day of the week, and identify the biggest drivers of consumption. Include specific numbers.";

    const response = await anthropicPost({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content?.[0]?.text || "Could not generate analysis.";
    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;

    // Pricing: Sonnet $3/M input, $15/M output
    const costUSD = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);
    const costDisplay = formatCostGBP(costUSD);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysis: text,
        tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
        cost: costDisplay,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};