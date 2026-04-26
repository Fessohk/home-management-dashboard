const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  const store = getStore({
    name: "energy-settings",
    siteID: process.env.SITE_ID || "97c929b2-ba49-4387-8b70-54f63763d686",
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  if (event.httpMethod === "GET") {
    try {
      const settings = await store.get("settings", { type: "json" });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings || {}),
      };
    } catch {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) };
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body);
      await store.setJSON("settings", body);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: "Method not allowed" };
};