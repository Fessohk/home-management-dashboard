const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  const store = getStore({
    name: "energy-tags",
    siteID: process.env.SITE_ID || "97c929b2-ba49-4387-8b70-54f63763d686",
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  // GET — return all tags
  if (event.httpMethod === "GET") {
    try {
      const tags = await store.get("tags", { type: "json" });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tags || {}),
      };
    } catch {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      };
    }
  }

  // POST — save tags for a date
  if (event.httpMethod === "POST") {
    try {
      const { date, tags } = JSON.parse(event.body);
      let allTags = {};
      try { allTags = await store.get("tags", { type: "json" }) || {}; } catch {}

      if (!tags || tags.length === 0) {
        delete allTags[date];
      } else {
        allTags[date] = tags;
      }

      await store.setJSON("tags", allTags);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: "Method not allowed" };
};