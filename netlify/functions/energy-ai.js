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
  const gbp = usd * 0.79;
  if (gbp < 0.01) return "less than £0.01";
  return `£${gbp.toFixed(2)}`;
}

function getTimeOfDayContext(time) {
  if (!time) return "unknown time";
  const [h] = time.split(":").map(Number);
  if (h >= 0 && h < 6) return "middle of the night (00:00-06:00)";
  if (h >= 6 && h < 9) return "early morning (06:00-09:00)";
  if (h >= 9 && h < 12) return "mid-morning (09:00-12:00)";
  if (h >= 12 && h < 14) return "lunchtime (12:00-14:00)";
  if (h >= 14 && h < 17) return "afternoon (14:00-17:00)";
  if (h >= 17 && h < 20) return "evening (17:00-20:00)";
  if (h >= 20 && h < 23) return "late evening (20:00-23:00)";
  return "late night (23:00-00:00)";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
const { date, slots, avgProfile, dayOfWeekProfiles, tags, memoryNotes, householdProfile, summaryFocus, question, elecRate, conversationHistory } = JSON.parse(event.body);
    const dayName = new Date(date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });
    const totalKwh = Math.round(slots.reduce((s, r) => s + r.kwh, 0) * 100) / 100;
    const totalGbp = elecRate ? Math.round(totalKwh * elecRate / 100 * 100) / 100 : null;

    // Find anomalous slots (>2x average for that slot)
    const anomalies = slots.filter(s => {
      const avg = avgProfile[s.time];
      return avg && s.kwh > avg * 2 && s.kwh > 0.1;
    }).map(s => {
      const avg = avgProfile[s.time];
      return `${s.time} (${s.kwh} kWh — ${Math.round(s.kwh/avg)}x avg, ${getTimeOfDayContext(s.time)})`;
    });

    // Day of week typical
    const dowProfile = dayOfWeekProfiles?.[dayName];
    const dowTotal = dowProfile
      ? Math.round(Object.values(dowProfile).reduce((s, v) => s + v, 0) * 100) / 100
      : null;

    // Peak slot
    const peak = slots.length ? slots.reduce((max, s) => s.kwh > max.kwh ? s : max, { time: "unknown", kwh: 0 }) : null;

    const isQuestion = question && question.trim();

    const summaryPreference = `Give me a view on the most recent full day of data — total usage, cost, and anything notable versus my typical pattern for that day of the week. Then summarise the last 14 days, highlighting any days that stand out high or low and why.`;

    const systemPrompt = `You are an energy analyst for a UK household with a smart electricity meter. Provide sharp, specific analysis with actual numbers.

RULES:
- Always include actual numbers (kWh, £, percentages, times)
- Flag anomalies — anything more than 2x the average for that time slot
- Consider time of day — using a pressure washer at 23:30 is unusual
- Reference day-of-week patterns where you have data
- Never suggest specific appliances unless the data clearly points to one
- Be direct and conversational, no filler phrases
- The household has two people

${isQuestion ? "" : `FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
HEADLINE: [one sentence, max 10 words, include the date and day of week]
SUBTITLE: [2-3 sentences of analysis, referencing specific numbers and patterns in the data]
BULLETS:
- [specific insight with numbers]
- [specific insight with numbers]
- [specific insight with numbers, only if genuinely useful]`}

HOUSEHOLD PROFILE (built from 30 days of data):
${householdProfile || "Not yet generated — will improve over time."}

USER PREFERENCES FOR SUMMARY:
${summaryFocus || summaryPreference}

Household context notes:
${memoryNotes && memoryNotes.length ? memoryNotes.map(n => `[${n.date}] ${n.text}`).join("\n") : "None yet."}

Date being analysed: ${dayName}, ${date}
Period context: ${isQuestion ? "Follow-up question on the data below." : `Analysing most recent full day (${date}) plus last 14 days context.`}
Total usage: ${totalKwh} kWh${totalGbp ? ` (£${totalGbp})` : ""}
Rate: ${elecRate ? elecRate.toFixed(2) : "24.99"}p/kWh
Tags: ${tags && tags.length ? tags.join(", ") : "None"}
Typical ${dayName} total: ${dowTotal ? `${dowTotal} kWh` : "not enough data yet"}
Today vs typical: ${dowTotal ? `${totalKwh > dowTotal ? "+" : ""}${Math.round((totalKwh - dowTotal) / dowTotal * 100)}%` : "unknown"}

Anomalous slots (>2x average): ${anomalies.length ? anomalies.join("; ") : "None"}
Peak slot: ${peak ? `${peak.time} at ${peak.kwh} kWh (${getTimeOfDayContext(peak.time)})` : "unknown"}

Half-hourly data:
${slots.map(s => {
  const avg = avgProfile[s.time] || 0;
  const flag = avg && s.kwh > avg * 2 && s.kwh > 0.1 ? " ⚠" : "";
  return `${s.time}: ${s.kwh} kWh (avg ${avg} kWh)${flag}`;
}).join("\n")}`;


    // Build messages array — for follow-up questions include conversation history
    const messages = [];
    if (conversationHistory && conversationHistory.length) {
      conversationHistory.forEach(m => messages.push(m));
    }
    messages.push({ role: "user", content: isQuestion ? question.trim() : "Analyse this day's electricity usage." });

    const response = await anthropicPost({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });

    const text = response.content?.[0]?.text || "Could not generate analysis.";
    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const costUSD = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysis: text,
        tokens: { input: inputTokens, output: outputTokens },
        cost: formatCostGBP(costUSD),
        isQuestion: !!isQuestion,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};