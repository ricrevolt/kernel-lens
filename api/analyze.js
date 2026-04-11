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
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", () => {
      reject(new Error("Unable to read request body"));
    });
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = await readBody(req);
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return res.status(400).json({ error: "Query required" });

    let toolContent = query.trim();
    let isUrl = false;
    let scrapedSuccessfully = false;

    try {
      const url = new URL(query.trim());
      if (url.protocol === "http:" || url.protocol === "https:") isUrl = true;
    } catch (e) {}

    if (isUrl) {
      // Method 1: Jina AI Reader
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${query.trim()}`, {
          headers: {
            Accept: "text/plain",
            "User-Agent": "Mozilla/5.0 (compatible; KernelLens/1.0)",
          },
          signal: AbortSignal.timeout(12000),
        });
        if (jinaRes.ok) {
          const text = await jinaRes.text();
          if (text && text.length > 200) {
            toolContent = `Website content:\n\n${text.substring(0, 4000)}`;
            scrapedSuccessfully = true;
          }
        }
      } catch (e) {}

      // Method 2: Direct fetch fallback
      if (!scrapedSuccessfully) {
        try {
          const directRes = await fetch(query.trim(), {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
            },
            signal: AbortSignal.timeout(8000),
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
              toolContent = `Website text:\n\n${text.substring(0, 4000)}`;
              scrapedSuccessfully = true;
            }
          }
        } catch (e) {}
      }

      // Method 3: domain fallback
      if (!scrapedSuccessfully) {
        try {
          const urlObj = new URL(query.trim());
          const domain = urlObj.hostname.replace("www.", "");
          toolContent = domain;
        } catch (e) {}
      }
    }

    const systemPrompt = `You are a brutally honest AI product analyst. Return ONLY a valid JSON object — no markdown, no explanation, nothing else.

You analyze AI SaaS tools and expose the truth about whether they solve real problems or are expensive wrappers around OpenAI/Anthropic APIs.

VERDICT CRITERIA — be strict:
"Expensive Wrapper": charges $20-200/month to wrap an API call you could do yourself in ChatGPT or with a free tool. No proprietary data, no unique technology, no real workflow integration. This is 70-80% of the AI SaaS market.
"Real Solution": has proprietary technology, unique datasets, deep workflow integration, or solves something technically impossible with a simple prompt. Genuinely rare.
"Unclear": only if you truly cannot determine the core technology stack.

SCORING — be harsh:
1-3: pure wrapper, zero proprietary value
4-5: minor workflow value but still largely a wrapper  
6-7: some genuine value but overpriced for what it does
8-10: only for tools with real proprietary technology and proven ROI

FREE ALTERNATIVE — always suggest truly free tools only. Open source or permanent free tier. Never trials. Never freemium with heavy limits. If none: "No free alternative — this fills a real gap."

EXAMPLES of correct verdicts:
- Jasper AI → "Expensive Wrapper" (score: 2) — GPT wrapper for copywriting, ChatGPT does the same
- Copy.ai → "Expensive Wrapper" (score: 2) — identical to Jasper, zero proprietary tech
- Cursor → "Real Solution" (score: 9) — proprietary codebase context system, not replicable with prompts
- GitHub Copilot → "Real Solution" (score: 8) — deep IDE integration, trained on unique code data
- Notion AI → "Expensive Wrapper" (score: 3) — GPT added to Notion, use ChatGPT directly
- Midjourney → "Real Solution" (score: 9) — proprietary model, unique aesthetic, not replicable
- Grammarly → "Real Solution" (score: 7) — proprietary grammar model + unique writing database
- Any "AI [task] tool" charging $49/month → almost certainly "Expensive Wrapper"

Return JSON with these exact keys: claimed_problem, real_problem, free_alternative, target_audience, real_cost, verdict, score, key_insight, one_line_summary`;

    const userPrompt = scrapedSuccessfully
      ? `Analyze this AI tool based on its website content. Be direct and honest.\n\n${toolContent}\n\nReturn ONLY JSON with keys: claimed_problem, real_problem, free_alternative, target_audience, real_cost, verdict (exactly: "Real Solution" or "Expensive Wrapper" or "Unclear"), score (integer 1-10), key_insight, one_line_summary`
      : `Analyze this AI tool: "${toolContent}"\n\nReturn ONLY JSON with keys: claimed_problem, real_problem, free_alternative, target_audience, real_cost, verdict (exactly: "Real Solution" or "Expensive Wrapper" or "Unclear"), score (integer 1-10), key_insight, one_line_summary`;

    const groqRes = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 600,
        }),
      },
    );

    if (!groqRes.ok) {
      await groqRes.text().catch(() => "");
      return res
        .status(500)
        .json({ error: "Analysis service unavailable. Please try again." });
    }

    const data = await groqRes.json();
    let content = data.choices[0].message.content.trim();

    content = content
      .replace(/^```json\n?/i, "")
      .replace(/^```\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];

    const parsed = JSON.parse(content);

    const validVerdicts = ["Real Solution", "Expensive Wrapper", "Unclear"];
    if (!validVerdicts.includes(parsed.verdict)) parsed.verdict = "Unclear";
    parsed.score = Math.min(10, Math.max(1, parseInt(parsed.score, 10) || 5));

    const fields = [
      "claimed_problem",
      "real_problem",
      "free_alternative",
      "target_audience",
      "real_cost",
      "verdict",
      "score",
      "key_insight",
      "one_line_summary",
    ];
    fields.forEach((f) => {
      if (!parsed[f]) parsed[f] = f === "score" ? 5 : "—";
    });

    return res.status(200).json(parsed);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Analysis failed. Please try again." });
  }
};
