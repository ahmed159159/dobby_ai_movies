// api/ask.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { text, context } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });

    // ENV
    const FIREWORKS_KEY  = process.env.FIREWORKS_KEY;
    const FIREWORKS_MODEL = process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/llama-v3p1-70b-instruct';
    const RAPID_KEY = process.env.RAPIDAPI_KEY;
    const RAPID_HOST = process.env.RAPIDAPI_HOST || 'imdb236.p.rapidapi.com';
    const OMDB_KEY  = process.env.OMDB_KEY;

    // Helpers
    const cleanJson = (raw) => {
      if (!raw) return '{}';
      let t = (''+raw).trim();
      if (t.startsWith('```')) t = t.split('```').slice(1).join('```');
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      const sArr = t.indexOf('['), eArr = t.lastIndexOf(']');
      if (sArr !== -1 && eArr !== -1 && (s === -1 || sArr < s)) return t.substring(sArr, eArr+1);
      if (s !== -1 && e !== -1) return t.substring(s, e+1);
      return t;
    };

    const LANG_MAP = {
      korean: 'ko', korian: 'ko', korea: 'ko', koreanlang: 'ko',
      english: 'en', eng: 'en', american: 'en', us: 'en',
      arabic: 'ar', german: 'de', french: 'fr', japanese: 'ja', chinese: 'zh', hindi:'hi', spanish:'es'
    };
    const GENRE_CANON = ['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror','Music','Mystery','Romance','Sci-Fi','Thriller','War','Western'];

    // 1) Analyze with LLM -> filters + intent
    const ANALYSIS_PROMPT = `
You are "Dobby", a movie-search assistant. Extract filters from user text.
Return ONLY JSON:

{
  "type": "movie" | "tv" | null,
  "genre": "<One of ${GENRE_CANON.join(', ')} or null>",
  "language": "<ISO-639-1 like en, ko, de or null>",
  "year": "<exact year or null>",
  "year_after": "<min year or null>",
  "year_before": "<max year or null>",
  "min_rating": "<0-10 or null>",
  "actor": "<actor name or null>",
  "director": "<director name or null>",
  "is_broad_best": true|false,
  "summary": "<short one-line intent>"
}

Notes:
- Map natural words like "Korean/korian" to ISO code (ko).
- If user says "after 2015" -> year_after=2016 (strictly after). If "since 2015" -> year_after=2015.
- If user says "before 2000" -> year_before=1999 (strict).
- If user says "this year" -> year = current year.
- If the query is broad like "best movies ever", set is_broad_best=true.
User text: "${text}"
    `;

    const fw = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIREWORKS_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: FIREWORKS_MODEL,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: 'You extract clean, minimal JSON for movie searching.' },
          { role: 'user', content: ANALYSIS_PROMPT }
        ]
      })
    });
    const fwJson = await fw.json();
    const parsed = JSON.parse(cleanJson(fwJson?.choices?.[0]?.message?.content || '{}'));

    // Merge with context memory (follow-up support)
    const ctx = {
      type: parsed.type ?? context?.type ?? null,
      language: parsed.language ?? context?.language ?? null,
      year: parsed.year ?? context?.year ?? null,
      year_after: parsed.year_after ?? context?.year_after ?? null,
      year_before: parsed.year_before ?? context?.year_before ?? null,
      min_rating: parsed.min_rating ?? context?.min_rating ?? null,
      actor: parsed.actor ?? context?.actor ?? null,
      director: parsed.director ?? context?.director ?? null,
      genre: parsed.genre ?? context?.genre ?? null
    };

    // Normalize language from words (e.g. "korean")
    if (ctx.language && ctx.language.length > 2 && LANG_MAP[ctx.language.toLowerCase()]) {
      ctx.language = LANG_MAP[ctx.language.toLowerCase()];
    }

    // 2) Source fetching strategy (IMDb via RapidAPI + OMDb enrichment)
    async function rapid(path, qs) {
      const u = new URL(`https://${RAPID_HOST}${path}`);
      if (qs) Object.entries(qs).forEach(([k,v]) => (v!=null && v!=='') && u.searchParams.set(k, v));
      const r = await fetch(u.toString(), {
        headers: {
          'X-Rapidapi-Key': RAPID_KEY,
          'X-Rapidapi-Host': RAPID_HOST
        }
      });
      if (!r.ok) {
        const msg = `RapidAPI ${path} ${u.search ? u.search : ''} ${r.status}`;
        return { error: msg, items: [] };
      }
      const j = await r.json();
      return { items: Array.isArray(j) ? j : [j] };
    }

    async function omdbById(imdbID){
      if(!OMDB_KEY || !imdbID) return null;
      const u = new URL(`https://www.omdbapi.com/`);
      u.searchParams.set('i', imdbID);
      u.searchParams.set('apikey', OMDB_KEY);
      const r = await fetch(u.toString());
      if(!r.ok) return null;
      const j = await r.json();
      if (j?.Response === 'False') return null;
      return j;
    }

    // actor/director autocomplete -> id
    async function findNameId(name){
      if(!name) return null;
      const { items, error } = await rapid('/api/imdb/autocomplete', { query: name });
      if (error) return null;
      // pick first "Name" result if present, else first
      const hit = items.find(x => x?.type === 'Name') || items[0];
      return hit?.id || null;
    }

    // Build candidate list
    let candidates = [];

    // Case A: Actor
    if (ctx.actor) {
      const nm = await findNameId(ctx.actor);
      if (nm) {
        const r = await rapid(`/api/imdb/cast/${nm}/titles`);
        candidates = candidates.concat(r.items || []);
      }
    }

    // Case B: Director
    if (ctx.director) {
      const nm = await findNameId(ctx.director);
      if (nm) {
        const r = await rapid(`/api/imdb/director/${nm}/titles`);
        candidates = candidates.concat(r.items || []);
      }
    }

    // Case C: Broad "best" → seed from IMDb lists
    if (parsed.is_broad_best || (!ctx.actor && !ctx.director && !ctx.genre && !ctx.language && !ctx.year && !ctx.year_after && !ctx.year_before)) {
      const top = await rapid('/api/imdb/top250-movies');
      const pop = await rapid('/api/imdb/most-popular-movies');
      candidates = candidates.concat(top.items || [], pop.items || []);
    }

    // Case D: If we still need more or have clear genre/language/year → take popular + filter locally
    if (candidates.length < 40) {
      const pop = await rapid('/api/imdb/most-popular-movies');
      candidates = candidates.concat(pop.items || []);
    }

    // Basic type filter (movie/tv)
    if (ctx.type === 'movie') candidates = candidates.filter(x => (x.type||'').toLowerCase().includes('movie'));
    if (ctx.type === 'tv')    candidates = candidates.filter(x => (x.type||'').toLowerCase().includes('tv'));

    // Local filters (language / year / genre / rating)
    const yearNum = (d)=> {
      // IMDb objects have startYear or releaseDate
      if (xKey(d,'startYear')) return Number(d.startYear);
      if (xKey(d,'releaseDate')) return Number(String(d.releaseDate).slice(0,4));
      return null;
    };
    const xKey = (o,k)=> Object.prototype.hasOwnProperty.call(o || {}, k);

    if (ctx.language) {
      candidates = candidates.filter(x => {
        const langs = (x.spokenLanguages || []).map(s => (s||'').toLowerCase());
        // accept exact ISO code or english name containing language
        return langs.includes(ctx.language.toLowerCase()) || langs.some(s => s.startsWith(ctx.language.toLowerCase()));
      });
    }
    if (ctx.genre) {
      const G = ctx.genre.toLowerCase();
      candidates = candidates.filter(x => (x.genres||[]).map(g=>g.toLowerCase()).includes(G));
    }
    if (ctx.year) {
      candidates = candidates.filter(x => {
        const y = yearNum(x);
        return y === Number(ctx.year);
      });
    }
    if (ctx.year_after) {
      candidates = candidates.filter(x => {
        const y = yearNum(x);
        return y == null ? true : (y > Number(ctx.year_after));
      });
    }
    if (ctx.year_before) {
      candidates = candidates.filter(x => {
        const y = yearNum(x);
        return y == null ? true : (y < Number(ctx.year_before));
      });
    }

    // Enrich with OMDb ratings (best-effort)
    async function enrich(items){
      const out = [];
      for (const it of items.slice(0,120)) { // cap to keep latency
        const imdbID = it.id || it.imdbID;
        let extra = null;
        if (imdbID) extra = await omdbById(imdbID);
        out.push({
          ...it,
          imdbRating: extra?.imdbRating ? Number(extra.imdbRating) : (it.averageRating ?? null),
          metascore: extra?.Metascore && extra.Metascore !== 'N/A' ? Number(extra.Metascore) : null,
          year: it.startYear || (it.releaseDate? String(it.releaseDate).slice(0,4) : null),
          poster: extra?.Poster && extra.Poster!=='N/A' ? extra.Poster : (it.primaryImage || null),
          overview: extra?.Plot && extra.Plot!=='N/A' ? extra.Plot : (it.description || '')
        });
      }
      return out;
    }

    let enriched = await enrich(candidates);

    // Min rating filter after enrichment
    if (ctx.min_rating) {
      const min = Number(ctx.min_rating);
      enriched = enriched.filter(x => {
        const r = (x.imdbRating ?? x.averageRating ?? 0);
        return Number(r) >= min;
      });
    }

    // 3) Rank with LLM (true AI choice)
    async function rankMoviesWithAI(movies, query){
      if (!movies.length) return movies;
      const payload = {
        model: FIREWORKS_MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'You rank movies by how well they match the user intent. Output ONLY JSON array of {id, score}.' },
          { role: 'user', content:
`User query: "${query}"
Rate each from 0..100 by relevance. Prefer correct language/genre/year/rating/actor/director if implied.

Movies:
${JSON.stringify(movies.map(m => ({
  id: m.id || m.imdbID,
  title: m.primaryTitle || m.title || m.originalTitle,
  year: m.year || m.startYear,
  rating: m.imdbRating || m.averageRating || 0,
  genres: m.genres || [],
  overview: (m.overview || '').slice(0,400)
})))}
Return ONLY JSON like: [{"id":"tt0137523","score":95}, ...]`
          }
        ]
      };
      const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {'Authorization':`Bearer ${FIREWORKS_KEY}`,'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      let arr = [];
      try { arr = JSON.parse(cleanJson(j?.choices?.[0]?.message?.content || '[]')); }
      catch { arr = []; }
      const scoreMap = {};
      (arr||[]).forEach(x => scoreMap[String(x.id)] = Number(x.score)||0);
      return movies
        .map(m => ({...m, _score: scoreMap[String(m.id||m.imdbID)] || 0}))
        .sort((a,b) => b._score - a._score);
    }

    const ranked = await rankMoviesWithAI(enriched, text);
    const results = ranked.slice(0, 12);

    // 4) Friendly follow-up (always English as you requested)
    let followup = null;
    if (!ctx.year && !ctx.year_after && !ctx.year_before) {
      followup = `Want a specific year or era? Examples: "this year", "after 2015", "before 2000".`;
    } else if (!ctx.min_rating) {
      followup = `Set a minimum rating? e.g., "7+", "8+".`;
    } else if (!ctx.language) {
      followup = `Prefer a language? e.g., "Korean", "German", "English".`;
    } else if (!ctx.actor && !ctx.director) {
      followup = `Any favorite actor or director to prioritize?`;
    }

    res.status(200).json({
      summary: parsed.summary || `✅ Done. Found ${results.length} results.`,
      context: ctx,
      results,
      followup
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
