const REQUIRED_KEYS = [
  "claimed_problem",
  "real_problem",
  "free_alternative",
  "verdict",
  "score",
  "one_line_summary"
];

const ALLOWED_VERDICTS = new Set([
  "Real Solution",
  "Expensive Wrapper",
  "Unclear"
]);

function stripMarkdownFences(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(value) {
  const cleaned = stripMarkdownFences(value);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a valid JSON object.");
  }

  return cleaned.slice(start, end + 1);
}

function sanitizePayload(payload) {
  const sanitized = {};

  for (const key of REQUIRED_KEYS) {
    if (!(key in payload)) {
      throw new Error(`Missing key: ${key}`);
    }
  }

  sanitized.claimed_problem = String(payload.claimed_problem || "").trim();
  sanitized.real_problem = String(payload.real_problem || "").trim();
  sanitized.free_alternative = String(payload.free_alternative || "").trim();
  sanitized.one_line_summary = String(payload.one_line_summary || "").trim();

  const verdict = String(payload.verdict || "").trim();
  sanitized.verdict = ALLOWED_VERDICTS.has(verdict) ? verdict : "Unclear";

  const score = Number.parseInt(payload.score, 10);
  sanitized.score = Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 1;

  return sanitized;
}

async function readJsonBody(req) {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body;
  }

  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", () => {
      reject(new Error("Unable to read request body."));
    });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
  }

  try {
    const body = await readJsonBody(req);
    const query = typeof body.query === "string" ? body.query.trim() : "";

    if (!query) {
      return res.status(400).json({ error: "Query is required." });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a brutally honest AI product analyst. You analyze AI SaaS tools and return a JSON object only, no markdown, no explanation. Evaluate whether the tool solves a real deep problem or is just a wrapper around existing technology. Be precise and concise."
          },
          {
            role: "user",
            content: `Analyze this AI tool: ${query}. Return ONLY a JSON object with these exact keys: claimed_problem, real_problem, free_alternative, verdict (must be exactly one of: Real Solution, Expensive Wrapper, Unclear), score (integer 1-10), one_line_summary`
          }
        ]
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data && data.error && data.error.message
        ? data.error.message
        : "OpenAI request failed.";
      return res.status(502).json({ error: message });
    }

    const content = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!content) {
      throw new Error("OpenAI returned an empty response.");
    }

    const parsed = JSON.parse(extractJsonObject(content));
    const sanitized = sanitizePayload(parsed);

    return res.status(200).json(sanitized);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
};
