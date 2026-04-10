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
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return res.status(400).json({ error: "Query required" });

    let toolContent = query.trim();
    let isUrl = false;
    let scrapedSuccessfully = false;

    try {
      const url = new URL(query.trim());
      if (url.protocol === "http:" || url.protocol === "https:") {
        isUrl = true;
      }
    } catch (error) {}

    if (isUrl) {
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${query.trim()}`, {
          headers: {
            "Accept": "text/plain",
            "User-Agent": "Mozilla/5.0 (compatible; KernelLens/1.0)"
          },
          signal: AbortSignal.timeout(12000)
        });
        if (jinaRes.ok) {
          const text = await jinaRes.text();
          if (text && text.length > 200) {
            toolContent = `Website content for analysis:\n\n${text.substring(0, 4000)}`;
            scrapedSuccessfully = true;
          }
        }
      } catch (error) {}

      if (!scrapedSuccessfully) {
        try {
          const directRes = await fetch(query.trim(), {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5"
            },
            signal: AbortSignal.timeout(8000)
          });
          if (directRes.ok) {
            const html = await directRes.text();
            const text = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (text && text.length > 200) {
              toolContent = `Website text content:\n\n${text.substring(0, 4000)}`;
              scrapedSuccessfully = true;
            }
          }
        } catch (error) {}
      }

      if (!scrapedSuccessfully) {
        try {
          const urlObj = new URL(query.trim());
          const domain = urlObj.hostname.replace("www.", "");
          toolContent = `${domain} (analyze based on your knowledge of this product)`;
        } catch (error) {}
      }
    }

    const systemPrompt = `You are a brutally honest AI product analyst with comprehensive knowledge of the SaaS and AI tools market. You always return ONLY a valid JSON object - no markdown, no explanation, no text before or after the JSON.

Your analysis must be specific, direct, and genuinely useful. Never be vague or diplomatic. If a tool is a wrapper, say so clearly. If it is genuinely valuable, explain exactly why.

CRITICAL RULES:
- free_alternative: ONLY suggest 100% free tools - open source, permanent free tiers, or public resources. NEVER suggest paid tools or free trials. If no truly free alternative exists, write: "No free alternative — this fills a real gap."
- real_cost: estimate the realistic monthly cost for a typical user including all necessary tiers
- target_audience: be specific about WHO actually benefits from this tool
- better_if: describe the exact scenario where this tool makes sense
- avoid_if: describe exactly when someone should NOT use this tool
- key_insight: the one non-obvious thing most people miss about this product
- All text fields: maximum 20 words each, be concise and sharp`;

    const userPrompt = scrapedSuccessfully
      ? `Analyze this AI/SaaS tool based on its actual website content below. Be specific and accurate.\n\n${toolContent}\n\nReturn ONLY a JSON object with exactly these keys: claimed_problem, real_problem, free_alternative, target_audience, real_cost, verdict (exactly one of: "Real Solution", "Expensive Wrapper", "Unclear"), score (integer 1-10), better_if, avoid_if, key_insight, one_line_summary`
      : `Analyze this AI/SaaS tool: "${toolContent}"\n\nUse your full knowledge of this product. Return ONLY a JSON object with exactly these keys: claimed_problem, real_problem, free_alternative, target_audience, real_cost, verdict (exactly one of: "Real Solution", "Expensive Wrapper", "Unclear"), score (integer 1-10), better_if, avoid_if, key_insight, one_line_summary`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
        temperature: 0.2,
        max_tokens: 700
      })
    });

    if (!groqRes.ok) {
      await groqRes.text().catch(() => "");
      return res.status(500).json({ error: "Analysis service unavailable. Please try again." });
    }

    const data = await groqRes.json();
    let content = data.choices[0].message.content.trim();

    content = content.replace(/^```json\n?/i, "").replace(/^```\n?/i, "").replace(/\n?```$/i, "").trim();

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];

    const parsed = JSON.parse(content);

    const validVerdicts = ["Real Solution", "Expensive Wrapper", "Unclear"];
    if (!validVerdicts.includes(parsed.verdict)) parsed.verdict = "Unclear";
    parsed.score = Math.min(10, Math.max(1, parseInt(parsed.score, 10) || 5));

    const fields = ["claimed_problem", "real_problem", "free_alternative", "target_audience", "real_cost", "verdict", "score", "better_if", "avoid_if", "key_insight", "one_line_summary"];
    fields.forEach((field) => {
      if (!parsed[field]) parsed[field] = field === "score" ? 5 : "Analysis incomplete for this field.";
    });

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Analysis failed. Please try again." });
  }
};
