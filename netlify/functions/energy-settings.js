const { getStore } = require("@netlify/blobs");

function getStore_() {
  return getStore({
    name: "energy-settings",
    siteID: process.env.SITE_ID || "97c929b2-ba49-4387-8b70-54f63763d686",
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
}

exports.handler = async function (event) {
  const store = getStore_();

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
      let current = {};
      try { current = await store.get("settings", { type: "json" }) || {}; } catch {}

      // Merge — don't overwrite everything on every save
      const updated = { ...current, ...body };

      // If appending a memory note
      if (body.appendMemory) {
        const existing = current.memoryNotes || [];
        updated.memoryNotes = [...existing, {
          text: body.appendMemory,
          date: new Date().toISOString().slice(0, 10),
          type: body.memoryType || "manual",
        }];
        delete updated.appendMemory;
        delete updated.memoryType;
      }

      await store.setJSON("settings", updated);
      return { statusCode: 200, body: JSON.stringify({ success: true, settings: updated }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: "Method not allowed" };
};