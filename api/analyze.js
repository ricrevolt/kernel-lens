const VALID_VERDICTS = ["Real Solution", "Expensive Wrapper", "Unclear"];

function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
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
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", () => {
      reject(new Error("Unable to read request body"));
    });
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = await readBody(req);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return res.status(400).json({ error: "Query required" });

    let toolContent = query;
    let isUrl = false;

    try {
      const url = new URL(query);
      if (url.protocol === "http:" || url.protocol === "https:") {
        isUrl = true;
        try {
          const jinaResponse = await fetch(`https://r.jina.ai/${query}`, {
            headers: {
              "Accept": "text/plain",
              "X-No-Cache": "true"
            },
            signal: AbortSignal.timeout(10000)
          });
          if (jinaResponse.ok) {
            const text = await jinaResponse.text();
            toolContent = text.substring(0, 3000);
          }
        } catch (scrapeError) {
          toolContent = query;
        }
      }
    } catch (error) {
      toolContent = query;
    }

    const systemPrompt = `You are a brutally honest AI product analyst with deep knowledge of the SaaS market. You analyze AI tools and return ONLY a valid JSON object - no markdown, no explanation, no text before or after the JSON.

Analyze whether the tool solves a real deep problem or is just a wrapper around existing technology.

For the free_alternative field: ALWAYS suggest only 100% completely free tools - open source projects, tools with permanent free tiers, or public resources. NEVER suggest paid tools, free trials, or freemium tools with heavy limits. If no truly free alternative exists, write exactly: "No free alternative — this fills a real gap."

Be specific, direct, and honest. Do not be diplomatic. If it is a wrapper, say so clearly.`;

    const userPrompt = isUrl
      ? `Analyze this AI tool based on its website content:\n\n${toolContent}\n\nReturn ONLY a JSON object with these exact keys: claimed_problem (what the tool claims to solve, max 15 words), real_problem (what it actually solves at a deeper level, max 15 words), free_alternative (completely free alternatives only), verdict (exactly one of: "Real Solution", "Expensive Wrapper", "Unclear"), score (integer 1-10 based on how deeply it solves the real problem), one_line_summary (honest one-sentence assessment, max 20 words), key_insight (the one thing most people miss about this tool, max 20 words)`
      : `Analyze this AI tool: "${toolContent}"\n\nReturn ONLY a JSON object with these exact keys: claimed_problem (what the tool claims to solve, max 15 words), real_problem (what it actually solves at a deeper level, max 15 words), free_alternative (completely free alternatives only), verdict (exactly one of: "Real Solution", "Expensive Wrapper", "Unclear"), score (integer 1-10 based on how deeply it solves the real problem), one_line_summary (honest one-sentence assessment, max 20 words), key_insight (the one thing most people miss about this tool, max 20 words)`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(500).json({ error: "Analysis failed", details: error });
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();

    content = content.replace(/^```json\n?/i, "").replace(/^```\n?/i, "").replace(/\n?```$/i, "").trim();

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];

    const parsed = JSON.parse(content);
    if (!VALID_VERDICTS.includes(parsed.verdict)) parsed.verdict = "Unclear";
    parsed.score = Math.min(10, Math.max(1, parseInt(parsed.score, 10) || 5));

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Failed to analyze", details: err.message });
  }
};
